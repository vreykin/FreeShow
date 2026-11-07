import { get } from "svelte/store"
import type { WirelessInput } from "../../../../types/Show"
import { Main } from "../../../../types/IPC/Main"
import { AudioMicrophone } from "../../../audio/audioMicrophone"
import { AudioPlayer } from "../../../audio/audioPlayer"
import { requestMain } from "../../../IPC/main"
import { outputs, special } from "../../../stores"
import { isMainWindow } from "../../../utils/common"

export type WindowCrop = { top: number; left: number; right: number; bottom: number }
export type WirelessSession = { id: string; name: string; receiver: WirelessInput["receiver"]; crop?: WindowCrop }

// ----- SAVED INPUTS -----

export function getWirelessInputs(): WirelessInput[] {
    return get(special).wirelessInputs || []
}

export function saveWirelessInputs(inputs: WirelessInput[]) {
    special.update((a) => ({ ...a, wirelessInputs: inputs }))
}

// the mirroring session a saved input should show: same receiver app (or any), and a device name containing its device text
export function matchSession(input: Pick<WirelessInput, "receiver" | "device">, sessions: WirelessSession[]) {
    const device = (input.device || "").trim().toLowerCase()
    return sessions.find((session) => (input.receiver === "any" || session.receiver === input.receiver) && (!device || session.name.toLowerCase().includes(device))) || null
}

export async function getWirelessSessions(): Promise<WirelessSession[]> {
    return (await requestMain(Main.GET_WIRELESS_SOURCES)) || []
}

// ----- ON OUTPUT -----
// A wireless input on an output follows its device: when the phone reconnects (a new window), the output
// switches to it without a new transition. Its audio (if chosen) plays through the app's audio, like a
// microphone, while it is on the first output - and stops when it is cleared.

const CHECK_MS = 3000
let started = false
let playingAudio = ""

export function startWirelessInputs() {
    if (started || !isMainWindow()) return
    started = true
    setInterval(update, CHECK_MS)
    outputs.subscribe(() => updateAudio())
}

function wirelessOnOutputs() {
    return Object.entries(get(outputs)).filter(([, output]) => output.enabled && output.out?.background?.type === "wireless" && output.out.background.wireless)
}

async function update() {
    const onOutputs = wirelessOnOutputs()
    if (!onOutputs.length) return

    const sessions = await getWirelessSessions()
    const changes: { [outputId: string]: { windowId: string; crop?: WindowCrop } } = {}
    onOutputs.forEach(([outputId, output]) => {
        const session = matchSession(output.out!.background!.wireless!, sessions)
        const windowId = session?.id || ""
        // the window can also be resized (its frame stays the same size, so the fractions change)
        if (windowId !== (output.out!.background!.windowId || "") || JSON.stringify(session?.crop) !== JSON.stringify(output.out!.background!.crop)) changes[outputId] = { windowId, crop: session?.crop }
    })
    if (!Object.keys(changes).length) return

    outputs.update((a) => {
        Object.entries(changes).forEach(([outputId, { windowId, crop }]) => {
            const background = a[outputId]?.out?.background
            if (background?.type !== "wireless") return
            background.windowId = windowId
            background.crop = crop
        })
        return a
    })
}

function updateAudio() {
    const input = wirelessOnOutputs()[0]?.[1].out?.background?.wireless
    const wanted = input?.audioDeviceId || ""
    if (wanted === playingAudio) return

    if (playingAudio) AudioPlayer.stop("mic_sub_" + playingAudio)
    playingAudio = wanted
    if (wanted) AudioMicrophone.start(wanted, { name: `${input!.name} (audio)` })
}
