import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ desktopCapturer: { getSources: vi.fn() }, shell: { openPath: vi.fn(), openExternal: vi.fn() } }))

const { receiverOf } = await import("./wirelessSources")

describe("receiverOf (which mirroring app a window belongs to)", () => {
    it("recognises AirServer windows by their process, whatever the device is called", () => {
        expect(receiverOf({ title: "Vit's iPhone", process: "AirServer" })).toBe("AirServer")
        expect(receiverOf({ title: "Pixel 8", process: "AirServerConsole" })).toBe("AirServer")
    })

    it("recognises UxPlay and Windows' Wireless Display", () => {
        expect(receiverOf({ title: "UxPlay@DESKTOP", process: "uxplay" })).toBe("UxPlay")
        expect(receiverOf({ title: "SGC-Projector-UxPlay", process: "uxplay-windows" })).toBe("UxPlay")
        expect(receiverOf({ title: "Wireless Display", process: "ApplicationFrameHost" })).toBe("Wireless Display")
        expect(receiverOf({ title: "Connect", process: "ApplicationFrameHost" })).toBe("Wireless Display")
    })

    it("ignores everything else", () => {
        expect(receiverOf({ title: "Wireless Display settings - Notepad", process: "notepad" })).toBeNull()
        expect(receiverOf({ title: "SGC Songs", process: "SGC-Songs" })).toBeNull()
    })
})
