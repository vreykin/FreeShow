// Electron names the per-PC settings folder (%APPDATA%\<app name> on Windows) after the app's
// product name. That folder holds config.json, which says where the data folder is, plus the
// local settings - so every rename of this app ("FreeShow" -> "FreeShow (Remastered)" -> "SGC Songs")
// silently started from an empty folder and lost track of the data folder.
// This pins it to whichever of the known names was used last (FreeShow's own by default).
// Imported first in index.ts: it must run before any settings store is created.

import { app } from "electron"
import fs from "fs"
import path from "path"

const KNOWN_FOLDER_NAMES = ["FreeShow", "FreeShow (Remastered)", "SGC Songs"]

export function pickAppDataFolder(appDataRoot: string, names = KNOWN_FOLDER_NAMES): string {
    let best = { folder: path.join(appDataRoot, names[0]), modified: -1 }

    for (const name of names) {
        const folder = path.join(appDataRoot, name)
        try {
            const modified = fs.statSync(path.join(folder, "config.json")).mtimeMs
            if (modified > best.modified) best = { folder, modified }
        } catch {
            // no settings under this name
        }
    }

    return best.folder
}

if (!process.env.FS_MOCK_STORE_PATH) {
    try {
        app.setPath("userData", pickAppDataFolder(app.getPath("appData")))
    } catch (err) {
        console.error("Could not set the app data folder:", err)
    }
}
