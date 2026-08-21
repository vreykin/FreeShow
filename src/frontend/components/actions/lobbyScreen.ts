// Switches a lobby screen (see the SGC projection hub) between its default
// looping video and a live mirror of a FreeShow output. The hub URL is a
// user setting (Settings > Files > "Lobby Projection"), not hardcoded, so
// this works with whatever hub the operator has configured - same idea as
// the existing Song Library sync IP field right above it in that tab.
import { get } from "svelte/store"
import { lobbyHubUrl } from "../../stores"
import type { API_lobby_screen } from "./api"

export function setLobbyScreenSource(data: API_lobby_screen) {
    const host = get(lobbyHubUrl).trim()
    if (!host) return

    const base = /^https?:\/\//i.test(host) ? host : `http://${host}`
    const url = base.replace(/\/$/, "") + "/api/live/source"
    const screen = data.screen === "left" || data.screen === "right" ? data.screen : "both"
    const source = data.source === "deck" ? "deck" : "freeshow"

    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ screen, source }) }).catch(() => {})
}
