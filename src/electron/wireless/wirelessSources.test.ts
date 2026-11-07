import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ desktopCapturer: { getSources: vi.fn() }, shell: { openPath: vi.fn(), openExternal: vi.fn() } }))

const { receiverOf, windowCrop } = await import("./wirelessSources")

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

describe("windowCrop (title bar and borders cut off on output)", () => {
    it("measured on the projector PC: UxPlay's 1924x1127 window holds an exact 1920x1080 picture", () => {
        const crop = windowCrop({ hwnd: 1, title: "AirPlay Video Stream", process: "uxplay-windows", width: 1924, height: 1127, top: 45, left: 2, right: 2, bottom: 2 })!
        const visibleWidth = 1924 * (1 - crop.left - crop.right)
        const visibleHeight = 1127 * (1 - crop.top - crop.bottom)
        expect(Math.round(visibleWidth)).toBe(1920)
        expect(Math.round(visibleHeight)).toBe(1080)
    })

    it("leaves windows without frame info uncropped", () => {
        expect(windowCrop({ hwnd: 1, title: "x", process: "airserver", width: 800, height: 600 })).toBeUndefined()
    })
})
