import type { Bible } from "json-bible/lib/Bible"
import path from "path"
import type { Main } from "../../types/IPC/Main"
import { ToMain } from "../../types/IPC/ToMain"
import type { SaveData } from "../../types/Save"
import { currentlyDeletedShows } from "../cloud/drive"
import { setLocalFileModified } from "../cloud/syncManager"
import { startBackup } from "../data/backup"
import { defaultSettings, defaultSyncedSettings } from "../data/defaults"
import { _store, safeStoreSet } from "../data/store"
import { sendMain, sendToMain } from "../IPC/main"
import { deleteFile, doesPathExist, getDataFolderPath, parseShow, readFile, writeFile } from "../utils/files"
import { checkIfMatching, clone, wait } from "../utils/helpers"
import { renameShows } from "../utils/shows"

// Full-file stores that use real edit timestamps instead of file mtime for cloud sync comparison.
// Prevents sync writes from falsely flagging stores as newer.
const TRACK_FILE_MODIFIED = ["EVENTS", "THEMES", "MEDIA"]

let isSaving = false
export async function save(data: SaveData) {
    if (isSaving) return
    isSaving = true

    // auto backup right after startup does not need to write again
    const isAutoBackupOnly = !!data.customTriggers?.backup && !!data.customTriggers?.isAutoBackup && !data.customTriggers?.autosave && !data.closeWhenFinished
    if (isAutoBackupOnly) {
        // write SETTINGS to disk on backup only to keep "special.autoBackupPrevious" up to date
        if (_store.SETTINGS && data.SETTINGS && isValidJSON(data.SETTINGS)) await safeStoreSet(_store.SETTINGS, data.SETTINGS, "SETTINGS")

        startBackup({ customTriggers: data.customTriggers }).catch((err) => console.error("Backup failed:", err))
        sendToMain(ToMain.SAVE2, { closeWhenFinished: false, customTriggers: data.customTriggers })
        isSaving = false
        return
    }

    const reset = !!data.customTriggers?.reset
    if (reset) {
        data.SETTINGS = clone(defaultSettings)
        data.SYNCED_SETTINGS = clone(defaultSyncedSettings)
    }

    // save to files
    for (const entry of Object.entries(_store)) {
        await storeData(entry as any)
    }
    async function storeData([key, store]: [keyof typeof _store, any]) {
        const newData = (data as any)[key]
        if (!newData || !isValidJSON(newData)) return

        let currentData
        try {
            currentData = store.store
        } catch {
            currentData = {}
        }
        if (checkIfMatching(currentData, newData)) return

        await safeStoreSet(store, newData, key)
        if (TRACK_FILE_MODIFIED.includes(key)) await setLocalFileModified(key, Date.now())

        if (reset) sendMain(key as Main, newData)
    }

    // scriptures
    const scriptureFolderPath = getDataFolderPath("scriptures")
    if (data.scripturesCache) Object.entries(data.scripturesCache).forEach(saveScripture)
    function saveScripture([id, value]: [string, Bible]) {
        if (!value || !isValidJSON(value)) return
        const filePath: string = path.join(scriptureFolderPath, value.name + ".fsb")
        writeFile(filePath, JSON.stringify([id, value]), id)
    }

    const showsPath = getDataFolderPath("shows")
    // rename shows
    if (data.renamedShows) {
        const renamedShows = data.renamedShows.filter(({ id }: { id: string }) => !data.deletedShows?.find((a) => a.id === id))
        await renameShows(renamedShows, showsPath)
    }

    // shows
    if (data.showsCache) Object.entries(data.showsCache).forEach(saveShow)
    function saveShow([id, value]: [string, any]) {
        if (!value || !isValidJSON(value)) return
        const filePath: string = path.join(showsPath, String(value.name || id) + ".show")
        writeFile(filePath, JSON.stringify([id, value]), id)
    }

    // delete shows
    if (data.deletedShows) data.deletedShows.forEach(deleteShow)
    function deleteShow({ name, id }: { name: string; id: string }) {
        if (!id || data.showsCache?.[id]) return

        const filePath: string = path.join(showsPath, (name || id) + ".show")
        if (!doesPathExist(filePath)) return

        // load file to double check the ID (as a new show with the same name might have been created)
        const jsonData = readFile(filePath) || "{}"
        const show = parseShow(jsonData)
        if (show?.[0] !== id) return

        deleteFile(filePath)

        // update cloud
        currentlyDeletedShows.push(id)
    }

    // SAVED

    if (data.customTriggers?.backup) startBackup({ customTriggers: data.customTriggers }).catch((err) => console.error("Backup failed:", err))

    if (data.closeWhenFinished) await wait(300) // make sure files are written before closing
    if (!reset) sendToMain(ToMain.SAVE2, { closeWhenFinished: data.closeWhenFinished, customTriggers: data.customTriggers })

    isSaving = false
}

// Writes the synced settings (functions, emitters, tags...) to disk right away.
//
// The full save() only runs every 15 minutes or on a clean quit, so a function
// or emitter that was just created lived only in memory until then - and
// anything that ended the app first (quitting without saving, a crash, the PC
// being switched off) lost it. The renderer sends this a moment after every
// change to functions/emitters (see instantSave in frontend/utils/save.ts).
//
// After writing, the file is read back from disk and checked: if a function
// or emitter that was just saved isn't actually in the file (unwritable or
// redirected data folder, antivirus lock...), say so now instead of letting
// it disappear silently at the next start.
export async function saveSyncedSettingsNow(data: any) {
    if (!data || typeof data !== "object" || !Object.keys(data).length || !isValidJSON(data)) return
    const store = _store.SYNCED_SETTINGS
    if (!store) return

    // a full save writes this same file - let it finish first so it can't land after (and undo) this one
    for (let i = 0; i < 50 && isSaving; i++) await wait(100)

    let current: any = {}
    try {
        current = store.store
    } catch {
        /* unreadable: just write */
    }
    if (!checkIfMatching(current, data)) await safeStoreSet(store, data, "SYNCED_SETTINGS")

    try {
        const filePath: string = (store as any).path
        const onDisk = JSON.parse(readFile(filePath) || "{}")
        const missing: string[] = []
        for (const key of ["midiIn", "emitters"]) {
            for (const id of Object.keys(data[key] || {})) {
                if (!onDisk[key] || !(id in onDisk[key])) missing.push(`${key}.${id}`)
            }
        }
        if (missing.length) {
            console.error("SYNCED_SETTINGS verification failed, missing on disk:", missing, "file:", filePath)
            sendToMain(ToMain.ALERT, `Could not save your functions/emitters to disk (${filePath}). Check that the FreeShow data folder is writable.`)
        }
    } catch (err) {
        console.error("Could not verify SYNCED_SETTINGS after saving:", err)
    }
}

function isValidJSON(object: any) {
    try {
        JSON.stringify(object)
        return true
    } catch {
        return false
    }
}
