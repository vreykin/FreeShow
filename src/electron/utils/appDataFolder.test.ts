import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { setPath: vi.fn(), getPath: vi.fn(() => os.tmpdir()) } }))
process.env.FS_MOCK_STORE_PATH = "1" // don't touch the real app paths on import

const { pickAppDataFolder } = await import("./appDataFolder")

const roots: string[] = []
function makeRoot(configs: { [name: string]: number }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "appdata-"))
    roots.push(root)
    for (const [name, mtime] of Object.entries(configs)) {
        fs.mkdirSync(path.join(root, name))
        const file = path.join(root, name, "config.json")
        fs.writeFileSync(file, "{}")
        fs.utimesSync(file, mtime, mtime)
    }
    return root
}

describe("pickAppDataFolder (settings survive app renames)", () => {
    afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })))

    it("uses FreeShow's folder on a fresh PC", () => {
        const root = makeRoot({})
        expect(pickAppDataFolder(root)).toBe(path.join(root, "FreeShow"))
    })

    it("keeps using the old folder after a rename (no settings under the new name yet)", () => {
        const root = makeRoot({ "FreeShow (Remastered)": 1000 })
        expect(pickAppDataFolder(root)).toBe(path.join(root, "FreeShow (Remastered)"))
    })

    it("picks the most recently used one when several exist", () => {
        const root = makeRoot({ FreeShow: 1000, "FreeShow (Remastered)": 3000, "SGC Songs": 2000 })
        expect(pickAppDataFolder(root)).toBe(path.join(root, "FreeShow (Remastered)"))
    })
})
