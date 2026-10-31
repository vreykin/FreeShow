import { beforeEach, describe, expect, it, vi } from "vitest"
import { ToMain } from "../../types/IPC/ToMain"
import { sendToMain } from "../IPC/main"
import { saveSyncedSettingsNow } from "./save"
import { _store, safeStoreSet } from "./store"

// the real file is replaced by an in-memory "disk" so a failed write can be simulated
const disk: { [path: string]: string } = {}
const FILE = "/mock/data/settings_synced.json"

vi.mock("../IPC/main", () => ({ sendMain: vi.fn(), sendToMain: vi.fn() }))
vi.mock("../cloud/drive", () => ({ currentlyDeletedShows: [] }))
vi.mock("../cloud/syncManager", () => ({ setLocalFileModified: vi.fn() }))
vi.mock("../data/backup", () => ({ startBackup: vi.fn() }))
vi.mock("../data/defaults", () => ({ defaultSettings: {}, defaultSyncedSettings: {} }))
vi.mock("../utils/shows", () => ({ renameShows: vi.fn() }))
vi.mock("../utils/files", () => ({
    deleteFile: vi.fn(),
    doesPathExist: vi.fn(() => true),
    getDataFolderPath: vi.fn(() => "/mock/data"),
    parseShow: vi.fn(),
    readFile: vi.fn((p: string) => disk[p] ?? ""),
    writeFile: vi.fn()
}))
vi.mock("./store", () => ({
    _store: { SYNCED_SETTINGS: { path: "/mock/data/settings_synced.json", store: {} } },
    safeStoreSet: vi.fn(async (store: any, data: any) => {
        store.store = data
        disk[store.path] = JSON.stringify(data)
    })
}))

const synced = (actions: object, emitters: object) => ({ categories: {}, midiIn: actions, emitters })

describe("saveSyncedSettingsNow (functions + emitters are written immediately)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        for (const k of Object.keys(disk)) delete disk[k]
        ;(_store.SYNCED_SETTINGS as any).store = {}
    })

    it("writes a new emitter and function to disk, and a restart reads them back", async () => {
        const data = synced({ fn1: { name: "Start stream", triggers: ["emit_action:a"], actionValues: { "emit_action:a": { emitter: "em1" } } } }, { em1: { name: "My emitter", type: "http" } })
        await saveSyncedSettingsNow(data)

        expect(safeStoreSet).toHaveBeenCalledTimes(1)
        // "restart": read what is actually in the file
        const afterRestart = JSON.parse(disk[FILE])
        expect(afterRestart.midiIn.fn1.actionValues["emit_action:a"].emitter).toBe("em1")
        expect(afterRestart.emitters.em1.name).toBe("My emitter")
        expect(sendToMain).not.toHaveBeenCalled()
    })

    it("alerts when the function/emitter did not actually reach the file", async () => {
        // simulate an unwritable / redirected data folder: the write "succeeds" but nothing lands in the file
        vi.mocked(safeStoreSet).mockImplementationOnce(async (store: any, data: any) => {
            store.store = data
        })
        await saveSyncedSettingsNow(synced({ fn1: { name: "x" } }, { em1: { name: "y" } }))

        expect(sendToMain).toHaveBeenCalledWith(ToMain.ALERT, expect.stringContaining("Could not save your functions/emitters"))
    })

    it("does not rewrite the file when nothing changed", async () => {
        const data = synced({ fn1: { name: "x" } }, { em1: { name: "y" } })
        await saveSyncedSettingsNow(data)
        await saveSyncedSettingsNow(JSON.parse(JSON.stringify(data)))

        expect(safeStoreSet).toHaveBeenCalledTimes(1)
    })

    it("ignores empty or invalid payloads instead of wiping the file", async () => {
        await saveSyncedSettingsNow(synced({ fn1: { name: "x" } }, {}))
        vi.mocked(safeStoreSet).mockClear()

        await saveSyncedSettingsNow(undefined)
        await saveSyncedSettingsNow({})
        await saveSyncedSettingsNow("nope" as any)

        expect(safeStoreSet).not.toHaveBeenCalled()
        expect(JSON.parse(disk[FILE]).midiIn.fn1.name).toBe("x")
    })

    it("a later change keeps earlier functions (it saves the full current set)", async () => {
        await saveSyncedSettingsNow(synced({ fn1: { name: "first" } }, { em1: { name: "e1" } }))
        await saveSyncedSettingsNow(synced({ fn1: { name: "first" }, fn2: { name: "second" } }, { em1: { name: "e1" }, em2: { name: "e2" } }))

        const onDisk = JSON.parse(disk[FILE])
        expect(Object.keys(onDisk.midiIn)).toEqual(["fn1", "fn2"])
        expect(Object.keys(onDisk.emitters)).toEqual(["em1", "em2"])
    })
})
