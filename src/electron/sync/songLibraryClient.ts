// Live sync client connecting out to the Song Library web app's WebSocket
// server at /api/sync (see that project's lib/syncServer.js for the wire
// protocol this speaks — JSON envelopes {v:1, type, payload} with hello,
// full_sync_request, full_sync, song_upsert, song_delete, project_upsert,
// project_delete messages).
//
// Inbound only for now: applies web-app-originated changes to the local
// SHOWS/PROJECTS stores and pushes them into the renderer via the same
// sendMain(Main.SHOWS, ...) / sendMain(Main.PROJECTS, ...) calls the
// existing cloud sync (syncManager.ts) already uses. Outbound (pushing a
// FreeShow-originated edit back to the web app) is a separate, later step.
//
// Conflict resolution: last-write-wins by `timestamps.modified` (songs) or
// `modified` (projects) — an incoming update that isn't strictly newer than
// what's already on disk is dropped. This also prevents echo loops, since
// the web app never rebroadcasts a change back to the connection that sent
// it, but a plain full_sync on (re)connect could otherwise re-apply
// something already applied.
import path from "path"
import WebSocket from "ws"
import { Main } from "../../types/IPC/Main"
import type { Folders, Project, Projects } from "../../types/Projects"
import type { Show } from "../../types/Show"
import { _store, getStore, safeStoreSet } from "../data/store"
import { sendMain } from "../IPC/main"
import { deleteFileAsync, doesPathExist, getDataFolderPath, loadShows, readFile, writeFileAsync } from "../utils/files"

type SyncConfig = { enabled: boolean; ip: string; port: number }
type Envelope = { v: number; type: string; payload: any }

let ws: WebSocket | null = null
let config: SyncConfig | null = null
let manuallyClosed = true
let reconnectTimer: NodeJS.Timeout | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30000
const STARTUP_SYNC_DELAY = 6000

export function updateSongLibrarySync(data: SyncConfig) {
    const sameTarget = config?.enabled && config.ip === data.ip && config.port === data.port

    if (!data.enabled) {
        config = data
        disconnect()
        return
    }

    if (sameTarget && (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING)) {
        // already connected/connecting to this exact target - nothing to do
        config = data
        return
    }

    config = data
    disconnect()
    manuallyClosed = false
    reconnectDelay = 1000

    // right after launch the app is busy loading everything else - let it finish first
    const startupDelay = Math.max(0, STARTUP_SYNC_DELAY - process.uptime() * 1000)
    if (startupDelay)
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            connect()
        }, startupDelay)
    else connect()
}

function disconnect() {
    manuallyClosed = true
    stopVerifying()
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }
    if (ws) {
        ws.removeAllListeners()
        try {
            ws.close()
        } catch {
            // ignore
        }
        ws = null
    }
}

function connect() {
    if (!config?.enabled) return

    // Node on Windows can take ~20-30s to resolve the hostname "localhost"
    // (it tries the IPv6 ::1 route first, then falls back to IPv4 after a
    // long OS-level timeout) - macOS/Linux resolve it instantly. Using the
    // literal loopback address skips hostname resolution entirely.
    const host = config.ip === "localhost" ? "127.0.0.1" : config.ip
    const url = `ws://${host}:${config.port}/api/sync`
    console.log(`songLibraryClient: connecting to ${url}`)

    const socket = new WebSocket(url)
    ws = socket

    socket.on("open", () => {
        console.log("songLibraryClient: connected")
        reconnectDelay = 1000
        // caps lets the server tailor the response - "batched_songs" opts into
        // receiving the catalog as full_sync_songs batches instead of one giant
        // full_sync message (older servers just ignore it and send the legacy
        // shape, which handleFullSync still understands)
        send(socket, "hello", { client: "freeshow", caps: ["batched_songs", "known_songs"] })
        // what we already have - a server that understands it only sends songs that changed since
        // (older servers ignore it and send the whole catalog, which is still handled the same way)
        send(socket, "full_sync_request", { known: knownSongVersions() })
        startVerifying(socket)
    })

    socket.on("pong", () => (awaitingPong = false))

    socket.on("message", (raw: Buffer | string) => {
        // JSON.parse is synchronous and has no async variant - for a
        // full_sync of a large library (thousands of songs, each with full
        // lyrics/chords) this payload can be tens of MB, and parsing that
        // blocks the event loop for its entire duration with no way to
        // yield mid-parse. Logged explicitly (size + duration) to confirm
        // this is really where the time goes before committing to a bigger
        // fix (e.g. a delta sync protocol so full_sync doesn't need to
        // resend content the client already has).
        const byteLength = raw.length
        const tParseStart = Date.now()
        let msg: Envelope
        try {
            msg = JSON.parse(raw.toString())
        } catch {
            return
        }
        console.log(`songLibraryClient: received message type=${msg.type} bytes=${byteLength} parse=${Date.now() - tParseStart}ms`)
        handleMessage(msg).catch((err) => console.error("songLibraryClient: error handling message:", err.message))
    })

    socket.on("close", () => {
        if (ws !== socket) return // superseded by a newer connection
        stopVerifying()
        console.log("songLibraryClient: disconnected")
        ws = null
        scheduleReconnect()
    })

    socket.on("error", (err: Error) => {
        console.error("songLibraryClient: connection error:", err.message)
    })
}

// ----- STAYING IN SYNC -----
// Both sides keep checking on each other while connected:
// - heartbeat: a ping every 15s - a connection that stops answering (Wi-Fi drop, NAS restart, sleep)
//   is closed and reconnected right away instead of silently missing every change
// - verify: every 90s the app asks again for anything newer than what it has; normally the answer is
//   empty, but a change that got lost on the way is picked up within a minute and a half
const HEARTBEAT_MS = 15000
const VERIFY_MS = 90000
let heartbeatTimer: NodeJS.Timeout | null = null
let verifyTimer: NodeJS.Timeout | null = null
let awaitingPong = false

function startVerifying(socket: WebSocket) {
    stopVerifying()
    awaitingPong = false

    heartbeatTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        if (awaitingPong) {
            console.warn("songLibraryClient: no answer from the server, reconnecting")
            socket.terminate() // fires "close", which reconnects
            return
        }
        awaitingPong = true
        try {
            socket.ping()
        } catch {
            socket.terminate()
        }
    }, HEARTBEAT_MS)

    verifyTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        send(socket, "full_sync_request", { known: knownSongVersions() })
    }, VERIFY_MS)
}

function stopVerifying() {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (verifyTimer) clearInterval(verifyTimer)
    heartbeatTimer = null
    verifyTimer = null
}

function knownSongVersions() {
    const known: { [id: string]: number } = {}
    Object.entries(getStore("SHOWS") || {}).forEach(([id, show]: [string, any]) => {
        known[id] = show?.timestamps?.modified || 0
    })
    return known
}

function scheduleReconnect() {
    if (manuallyClosed || !config?.enabled) return
    if (reconnectTimer) return

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

function send(socket: WebSocket, type: string, payload: any) {
    if (socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ v: 1, type, payload }))
}

// Called by the IPC handler for Main.SONG_LIBRARY_SYNC_OUTBOUND (see
// responsesMain.ts) — a FreeShow-originated edit, detected by the renderer's
// songLibraryOutbound.ts, forwarded here to go out over the current
// connection. A silent no-op while disconnected/disabled, same as any other
// send() call — the web app is the source of truth, so a change made while
// disconnected simply stays local until the next edit is made while
// connected (full two-way reconciliation on reconnect is a later step).
export function sendOutbound(type: string, payload: any) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    send(ws, type, payload)

    if (type === "project_upsert" && payload?.id) markProjectsSynced([payload.id])
    else if (type === "project_delete" && payload?.id) unmarkProjectSynced(payload.id)
}

async function handleMessage(msg: Envelope) {
    if (!msg || typeof msg.type !== "string") return
    switch (msg.type) {
        case "full_sync":
            return handleFullSync(msg.payload)
        case "full_sync_songs":
            return handleFullSyncSongs(msg.payload)
        case "song_upsert":
            return handleSongUpsert(msg.payload)
        case "song_delete":
            return handleSongDelete(msg.payload)
        case "project_upsert":
            return handleProjectUpsert(msg.payload)
        case "project_delete":
            return handleProjectDelete(msg.payload)
    }
}

// ----- SONGS -----

function localShowModified(id: string): number {
    return getStore("SHOWS")[id]?.timestamps?.modified || 0
}

// Async (writeFileAsync/deleteFileAsync, not the sync writeFile/deleteFile
// used elsewhere in this file) specifically because handleFullSync below
// calls this once per song, and a full sync can be thousands of songs.
// Synchronous fs calls in that loop blocked the main process's event loop
// for the entire loop's duration - reported as the whole app freezing for
// ~30s on Windows on every reconnect (Defender's real-time scanning
// intercepts every single file write, which adds up fast over thousands of
// files; macOS has no equivalent per-write interception, so the same loop
// there was fast enough to go unnoticed). await-ing each write yields the
// event loop between songs so the app stays responsive throughout, even
// though the sync itself still takes real wall-clock time.
async function writeShowFile(id: string, show: Show) {
    const showsPath = getDataFolderPath("shows")
    const oldName = getStore("SHOWS")[id]?.name
    const fileName = String(show.name || id) + ".show"

    if (oldName && oldName + ".show" !== fileName) {
        const oldPath = path.join(showsPath, oldName + ".show")
        if (doesPathExist(oldPath)) await deleteFileAsync(oldPath)
    }

    await writeFileAsync(path.join(showsPath, fileName), JSON.stringify([id, show]), id)
}

async function applySongUpsert(id: string, show: Show): Promise<boolean> {
    if (!id || !show) return false
    if ((show.timestamps?.modified || 0) <= localShowModified(id)) return false // stale or an echo of our own change
    await writeShowFile(id, show)
    return true
}

async function handleSongUpsert(payload: { id: string; show: [string, Show] }) {
    if (!payload || !Array.isArray(payload.show)) return
    const [id, show] = payload.show
    if (!(await applySongUpsert(id, show))) return

    await refreshShows([show.name])
}

async function handleSongDelete(payload: { id: string }) {
    if (!payload?.id) return
    const local = getStore("SHOWS")[payload.id]
    if (!local) return

    const showsPath = getDataFolderPath("shows")
    const filePath = path.join(showsPath, local.name + ".show")
    if (doesPathExist(filePath)) await deleteFileAsync(filePath)

    await refreshShows([])
}

// loadShows() itself is synchronous (a single call blocks for its entire
// duration, same class of problem as the writes above) and, per song
// actually being refreshed, re-reads and re-parses that file from disk even
// though we already have its full content in memory from this same
// full_sync payload — necessary because it also rebuilds the trimmed
// metadata cache other parts of the app read, which this module has no
// other way to update. Calling it in small batches with a yield between
// each keeps any single blocking call short instead of one call blocking
// for the size of the entire changed set.
const REFRESH_BATCH_SIZE = 100

async function refreshShows(changedNames: string[]) {
    for (let i = 0; i < changedNames.length; i += REFRESH_BATCH_SIZE) {
        loadShows(false, changedNames.slice(i, i + REFRESH_BATCH_SIZE))
        await new Promise((resolve) => setImmediate(resolve))
    }
    pushShowsToWindow()
}

// the whole shows list goes to the window on every push, and the window then reprocesses it -
// during a full sync that used to happen after every batch, so changes are sent once they settle
let pushShowsTimeout: NodeJS.Timeout | null = null
function pushShowsToWindow() {
    if (pushShowsTimeout) clearTimeout(pushShowsTimeout)
    pushShowsTimeout = setTimeout(() => {
        pushShowsTimeout = null
        if (_store.SHOWS) sendMain(Main.SHOWS, _store.SHOWS.store)
    }, 400)
}

// ----- PROJECTS -----

// Ids of projects known to exist on the web app (received from it, or sent to it while connected).
// A project the web app deleted while FreeShow was closed never gets a project_delete, so on the
// next full_sync it is simply missing - this list is what tells "deleted on the web" (remove it
// here too) apart from "made in FreeShow while offline" (send it up). Without it, every past
// service stayed in FreeShow forever and showed up next to the new one with the same name.
const SYNC_STATE_FILE = "sgc_songs_sync.json"
let syncedProjectIds: Set<string> | null = null
let syncStateExisted = false

function syncStatePath() {
    return path.join(getDataFolderPath("userData"), SYNC_STATE_FILE)
}

function getSyncedProjectIds() {
    if (syncedProjectIds) return syncedProjectIds
    syncedProjectIds = new Set()
    try {
        const raw = readFile(syncStatePath())
        if (raw) {
            const ids = JSON.parse(raw)?.projectIds
            if (Array.isArray(ids)) ids.forEach((id) => syncedProjectIds!.add(id))
            syncStateExisted = true
        }
    } catch (err) {
        console.error("songLibraryClient: could not read sync state:", err)
    }
    return syncedProjectIds
}

let saveStateTimer: NodeJS.Timeout | null = null
function saveSyncState() {
    if (saveStateTimer) clearTimeout(saveStateTimer)
    saveStateTimer = setTimeout(() => {
        saveStateTimer = null
        writeFileAsync(syncStatePath(), JSON.stringify({ projectIds: [...getSyncedProjectIds()] })).catch((err) => console.error("songLibraryClient: could not save sync state:", err))
    }, 500)
}

function markProjectsSynced(ids: string[]) {
    const synced = getSyncedProjectIds()
    let changed = false
    ids.forEach((id) => {
        if (synced.has(id)) return
        synced.add(id)
        changed = true
    })
    if (changed) saveSyncState()
}

function unmarkProjectSynced(id: string) {
    if (getSyncedProjectIds().delete(id)) saveSyncState()
}

// web-app-made schedules carry these, FreeShow-made ones don't
function cameFromWebApp(project: Project) {
    return !!project && ("dateIso" in project || "ownerId" in project)
}

function currentProjectsData() {
    return getStore("PROJECTS") as { projects: Projects; folders: Folders; projectTemplates: Projects }
}

async function handleProjectUpsert(payload: { id: string; project: Project }) {
    if (!payload?.id || !payload.project) return
    const data = currentProjectsData()
    const local = data.projects[payload.id]
    if ((payload.project.modified || 0) <= (local?.modified || 0)) return

    data.projects[payload.id] = payload.project
    markProjectsSynced([payload.id])
    await safeStoreSet(_store.PROJECTS, data, "PROJECTS")
    sendMain(Main.PROJECTS, data)
}

async function handleProjectDelete(payload: { id: string }) {
    if (!payload?.id) return
    const data = currentProjectsData()
    unmarkProjectSynced(payload.id)
    if (!data.projects[payload.id]) return

    delete data.projects[payload.id]
    await safeStoreSet(_store.PROJECTS, data, "PROJECTS")
    sendMain(Main.PROJECTS, data)
}

// ----- FULL SYNC -----

async function handleFullSync(payload: { songs?: [string, Show][]; projects?: { projects: Projects; folders: Folders; projectTemplates: Projects } }) {
    // Timed explicitly (not just "did it freeze or not") so a slow full_sync
    // reported in the future points straight at which phase is actually
    // responsible instead of requiring another guess-fix-rebuild round trip.
    const totalSongs = payload?.songs?.length || 0
    const tWriteStart = Date.now()
    const changedNames: string[] = []
    for (const [id, show] of payload?.songs || []) {
        if (await applySongUpsert(id, show)) changedNames.push(show.name)
    }
    console.log(`songLibraryClient: full_sync wrote ${changedNames.length}/${totalSongs} songs in ${Date.now() - tWriteStart}ms`)

    if (changedNames.length) {
        const tRefreshStart = Date.now()
        await refreshShows(changedNames)
        console.log(`songLibraryClient: full_sync refreshed shows cache (${changedNames.length} names) in ${Date.now() - tRefreshStart}ms`)
    }

    if (payload?.projects) await reconcileProjects(payload.projects)
}

async function reconcileProjects(remote: { projects: Projects; folders: Folders; projectTemplates: Projects }) {
    const data = currentProjectsData()
    const remoteProjects = remote.projects || {}
    const synced = getSyncedProjectIds()
    const firstRun = !syncStateExisted
    const toPush: string[] = []
    let changed = false

    for (const [id, project] of Object.entries(remoteProjects)) {
        const local = data.projects[id]
        if ((project.modified || 0) <= (local?.modified || 0)) continue
        data.projects[id] = project
        changed = true
    }

    // local projects the web app doesn't have
    for (const [id, project] of Object.entries(data.projects)) {
        if (remoteProjects[id]) continue

        if (synced.has(id) || cameFromWebApp(project)) {
            // it was on the web app before - it has been deleted there since
            delete data.projects[id]
            changed = true
            console.log(`songLibraryClient: removed project "${project?.name}" (${id}), deleted on the web app`)
        } else if (!firstRun) {
            // made here while disconnected - send it up instead of losing it
            // (not on the very first run: the old local projects are left alone rather than all uploaded)
            toPush.push(id)
        }
    }

    // the web app doesn't store FreeShow's folders - keep the local ones, add any it does have
    data.folders = { ...(data.folders || {}), ...(remote.folders || {}) }
    if (remote.projectTemplates && Object.keys(remote.projectTemplates).length) data.projectTemplates = remote.projectTemplates

    // runs every verify - only touch the file when the list actually changed
    const remoteIds = Object.keys(remoteProjects)
    const sameIds = syncStateExisted && remoteIds.length === synced.size && remoteIds.every((id) => synced.has(id))
    syncedProjectIds = new Set(remoteIds)
    syncStateExisted = true
    if (!sameIds) saveSyncState()

    if (changed) {
        await safeStoreSet(_store.PROJECTS, data, "PROJECTS")
        sendMain(Main.PROJECTS, data)
    }

    toPush.forEach((id) => sendOutbound("project_upsert", { id, project: data.projects[id] }))
}

// One batch of songs from the batched full sync (see syncServer.js's
// sendFullSync). Applying and refreshing per batch - rather than parsing and
// writing the entire catalog from a single full_sync message - keeps the main
// process responsive on startup, and streams songs into the library
// progressively instead of all appearing at once at the end.
async function handleFullSyncSongs(payload: { songs?: [string, Show][]; last?: boolean }) {
    const changedNames: string[] = []
    for (const [id, show] of payload?.songs || []) {
        if (await applySongUpsert(id, show)) changedNames.push(show.name)
    }

    if (changedNames.length) await refreshShows(changedNames)
}
