import { writable } from "svelte/store"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createInstantSave } from "./instantSave"

function setup() {
    const actions = writable<any>({})
    const emitters = writable<any>({})
    const loadedState = writable<string[]>([])
    const send = vi.fn()
    const instant = createInstantSave({ actions, emitters, loadedState, collectSyncedSettings: () => ({ midiIn: JSON.parse(JSON.stringify(actions_value())), emitters: JSON.parse(JSON.stringify(emitters_value())) }), send, delayMs: 800 })
    let a: any = {}
    let e: any = {}
    actions.subscribe((v) => (a = v))
    emitters.subscribe((v) => (e = v))
    function actions_value() {
        return a
    }
    function emitters_value() {
        return e
    }
    instant.start()
    return { actions, emitters, loadedState, send, instant }
}

// what the app does at startup: the settings file is loaded into the stores, then marked as loaded
function loadFromDisk(ctx: ReturnType<typeof setup>, actions: any, emitters: any) {
    ctx.actions.set(actions)
    ctx.emitters.set(emitters)
    ctx.loadedState.update((l) => [...l, "synced_settings"])
}

describe("instant save of functions and emitters", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it("saves a new emitter + function shortly after they are created", () => {
        const ctx = setup()
        loadFromDisk(ctx, {}, {})
        ctx.emitters.update((e) => ({ ...e, em1: { name: "My emitter" } }))
        ctx.actions.update((a) => ({ ...a, fn1: { name: "Start", actionValues: { x: { emitter: "em1" } } } }))

        expect(ctx.send).not.toHaveBeenCalled() // debounced
        vi.advanceTimersByTime(800)

        expect(ctx.send).toHaveBeenCalledTimes(1)
        const sent = ctx.send.mock.calls[0][0]
        expect(sent.emitters.em1.name).toBe("My emitter")
        expect(sent.midiIn.fn1.actionValues.x.emitter).toBe("em1")
    })

    it("many quick edits become one write containing all of them", () => {
        const ctx = setup()
        loadFromDisk(ctx, {}, {})
        for (let i = 0; i < 5; i++) {
            ctx.actions.update((a) => ({ ...a, ["fn" + i]: { name: "f" + i } }))
            vi.advanceTimersByTime(300)
        }
        vi.advanceTimersByTime(800)

        expect(ctx.send).toHaveBeenCalledTimes(1)
        expect(Object.keys(ctx.send.mock.calls[0][0].midiIn)).toHaveLength(5)
    })

    it("flush (called on quit) writes immediately without waiting for the delay", () => {
        const ctx = setup()
        loadFromDisk(ctx, {}, {})
        ctx.actions.update((a) => ({ ...a, fn1: { name: "x" } }))

        ctx.instant.flush()
        expect(ctx.send).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(2000) // the pending timer must not write a second time
        expect(ctx.send).toHaveBeenCalledTimes(1)
    })

    it("does not write when the settings file was just loaded (that load is not a change)", () => {
        const ctx = setup()
        loadFromDisk(ctx, { fn1: { name: "existing" } }, { em1: { name: "existing" } })
        vi.advanceTimersByTime(5000)
        ctx.instant.flush()

        expect(ctx.send).not.toHaveBeenCalled()
    })

    it("never writes before the settings file has loaded (it would save empty defaults over everything)", () => {
        const ctx = setup()
        ctx.actions.update((a) => ({ ...a, fn1: { name: "x" } }))
        vi.advanceTimersByTime(5000)
        ctx.instant.flush()

        expect(ctx.send).not.toHaveBeenCalled()
    })

    it("does not write again when nothing changed", () => {
        const ctx = setup()
        loadFromDisk(ctx, {}, {})
        ctx.actions.update((a) => ({ ...a, fn1: { name: "x" } }))
        vi.advanceTimersByTime(800)
        ctx.actions.update((a) => ({ ...a })) // same content, new object
        vi.advanceTimersByTime(800)
        ctx.instant.flush()

        expect(ctx.send).toHaveBeenCalledTimes(1)
    })

    it("a deleted function is saved too (the file must not keep a stale copy)", () => {
        const ctx = setup()
        loadFromDisk(ctx, { fn1: { name: "a" }, fn2: { name: "b" } }, {})
        ctx.actions.update((a) => {
            const { fn1, ...rest } = a
            return rest
        })
        vi.advanceTimersByTime(800)

        expect(Object.keys(ctx.send.mock.calls[0][0].midiIn)).toEqual(["fn2"])
    })
})
