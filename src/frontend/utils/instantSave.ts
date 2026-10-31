import { get, type Readable } from "svelte/store"

// Functions (actions) and emitters are small, set up by hand and wired to each
// other, so losing them is painful - but they used to be written to disk only
// by the full save (every 15 minutes, or a clean quit). Anything that ended the
// app first (quitting without saving, a crash, the PC switched off) lost them.
// This writes them a moment after every change instead.

type InstantSaveDeps = {
    actions: Readable<any>
    emitters: Readable<any>
    loadedState: Readable<string[]>
    // every synced setting, as it should be written to the file
    collectSyncedSettings: () => { [key: string]: any }
    send: (syncedSettings: { [key: string]: any }) => void
    delayMs?: number
}

export function createInstantSave(deps: InstantSaveDeps) {
    const delayMs = deps.delayMs ?? 800

    let timer: ReturnType<typeof setTimeout> | null = null
    let ready = false
    let snapshot = ""

    const settingsLoaded = () => get(deps.loadedState).includes("synced_settings")
    const currentState = () => JSON.stringify([get(deps.actions), get(deps.emitters)])

    function flush() {
        if (timer) {
            clearTimeout(timer)
            timer = null
        }
        // never write before the settings file has been loaded: the stores would still hold empty defaults
        if (!ready || !settingsLoaded()) return

        const state = currentState()
        if (state === snapshot) return
        snapshot = state

        deps.send(deps.collectSyncedSettings())
    }

    function onChange() {
        // loading the file itself changes the stores - wait for it, and treat what was loaded as "already saved"
        if (!settingsLoaded()) return
        if (!ready) {
            ready = true
            snapshot = currentState()
            return
        }

        if (currentState() === snapshot) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(flush, delayMs)
    }

    function start() {
        const unsubscribers = [deps.actions.subscribe(onChange), deps.emitters.subscribe(onChange), deps.loadedState.subscribe(onChange)]
        return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
    }

    return { start, flush }
}
