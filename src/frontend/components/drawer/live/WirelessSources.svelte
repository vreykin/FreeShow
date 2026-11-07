<script lang="ts">
    import { onDestroy, onMount } from "svelte"
    import { uid } from "uid"
    import { Main } from "../../../../types/IPC/Main"
    import type { WirelessInput } from "../../../../types/Show"
    import { AudioMicrophone } from "../../../audio/audioMicrophone"
    import { sendMain } from "../../../IPC/main"
    import { outLocked, outputs, special } from "../../../stores"
    import { clone } from "../../helpers/array"
    import Icon from "../../helpers/Icon.svelte"
    import { findMatchingOut, getFirstActiveOutput, setOutput } from "../../helpers/output"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import MaterialDropdown from "../../inputs/MaterialDropdown.svelte"
    import MaterialTextInput from "../../inputs/MaterialTextInput.svelte"
    import { clearBackground } from "../../output/clear"
    import Card from "../Card.svelte"
    import Capture from "./Capture.svelte"
    import { getWirelessSessions, matchSession, saveWirelessInputs, type WirelessSession } from "./wirelessInputs"

    // AirPlay / Google Cast / Miracast, received by AirServer, UxPlay or Windows' Wireless Display
    // and captured from their mirroring window (see electron/wireless/wirelessSources.ts).
    // Saved inputs (like ProPresenter's) stay listed and pick up their device whenever it mirrors.

    export let streams: MediaStream[]

    let sessions: WirelessSession[] = []
    let loaded = false

    // phones connect and disconnect while this is open - keep the list current
    const REFRESH_MS = 3000
    let interval: ReturnType<typeof setInterval> | null = null
    onMount(() => {
        refresh()
        interval = setInterval(refresh, REFRESH_MS)
    })
    onDestroy(() => {
        if (interval) clearInterval(interval)
    })

    async function refresh() {
        const list = await getWirelessSessions()
        loaded = true
        // keep the same objects when nothing changed, so running captures aren't restarted
        if (JSON.stringify(list) !== JSON.stringify(sessions)) sessions = list
    }

    $: inputs = ($special.wirelessInputs || []) as WirelessInput[]
    $: matched = inputs.map((input) => ({ input, session: matchSession(input, sessions) }))
    // sessions no saved input is showing
    $: unassigned = sessions.filter((session) => !matched.some((a) => a.session?.id === session.id))

    // ----- OUTPUT -----

    // a device without a saved input still goes out as a wireless input (cropped, and following it through reconnects)
    function clickSession(event: any, session: WirelessSession) {
        showInput(event, { id: "wireless_" + session.receiver + "_" + session.name, name: session.name, receiver: session.receiver, device: session.name }, session)
    }

    function showInput(e: any, input: WirelessInput, session: WirelessSession | null) {
        if ($outLocked || e?.ctrlKey || e?.metaKey) return
        if (getFirstActiveOutput($outputs)?.out?.background?.id === input.id) return clearBackground()

        setOutput("background", { id: input.id, name: input.name, type: "wireless", wireless: clone(input), windowId: session?.id || "", crop: session?.crop })
    }

    // ----- EDITING -----

    const receiverOptions = [
        { value: "any", label: "Any receiver" },
        { value: "AirServer", label: "AirServer (AirPlay, Google Cast, Miracast)" },
        { value: "Wireless Display", label: "Windows Wireless Display (Miracast)" },
        { value: "UxPlay", label: "UxPlay (AirPlay)" }
    ]

    let editing: WirelessInput | null = null
    let audioOptions: { value: string; label: string }[] = []

    async function edit(input: WirelessInput | null, fromSession: WirelessSession | null = null) {
        editing = input ? clone(input) : { id: uid(), name: fromSession?.name || "Wireless input", receiver: fromSession?.receiver || "AirServer", device: fromSession?.name || "", audioDeviceId: "" }
        const devices: { value: string; label: string }[] = await AudioMicrophone.getInputs().catch(() => [])
        audioOptions = [{ value: "none", label: "No audio" }, ...devices.map((a) => ({ value: a.value, label: a.label }))]
    }

    function saveEditing() {
        if (!editing) return
        const input = { ...editing, name: editing.name.trim() || "Wireless input", device: editing.device.trim() }
        const exists = inputs.some((a) => a.id === input.id)
        saveWirelessInputs(exists ? inputs.map((a) => (a.id === input.id ? input : a)) : [...inputs, input])
        editing = null
    }

    function deleteEditing() {
        if (!editing) return
        const id = editing.id
        saveWirelessInputs(inputs.filter((a) => a.id !== id))
        editing = null
    }

    $: deviceOptions = [{ value: "", label: "Any device" }, ...[...new Set([...sessions.map((a) => a.name), editing?.device || ""].filter(Boolean))].map((name) => ({ value: name, label: name }))]
</script>

<div class="title">
    <Icon id="cast" white />
    <p>Wireless</p>
    <span>AirPlay · Google Cast · Miracast</span>
    <div style="flex: 1;" />
    <MaterialButton icon="add" title="New wireless input" on:click={() => edit(null)}>New input</MaterialButton>
</div>

{#if editing}
    <div class="editor">
        <MaterialTextInput label="Name" value={editing.name} on:change={(e) => editing && (editing.name = e.detail)} />
        <MaterialDropdown label="Receiver" value={editing.receiver} options={receiverOptions} on:change={(e) => editing && (editing.receiver = e.detail)} />
        <MaterialDropdown label="Device" value={editing.device} options={deviceOptions} on:change={(e) => editing && (editing.device = e.detail)} />
        <MaterialTextInput label="Device name contains" title="Matches any mirroring device whose name contains this, e.g. iPad" value={editing.device} on:change={(e) => editing && (editing.device = e.detail)} />
        <MaterialDropdown label="Relay audio from" title="An audio input to play along with this input - set the receiver's audio output to a virtual audio cable and pick that cable here" value={editing.audioDeviceId || "none"} options={audioOptions} on:change={(e) => editing && (editing.audioDeviceId = e.detail === "none" ? "" : e.detail)} />
        <p class="hint">For audio: set AirServer's (or Windows') sound output to a virtual audio cable (e.g. the free VB-CABLE), then pick that cable here. The sound then plays through SGC Songs while this input is on screen.</p>
        <div class="buttons">
            <MaterialButton variant="outlined" icon="check" on:click={saveEditing}>Save</MaterialButton>
            <MaterialButton variant="outlined" icon="close" on:click={() => (editing = null)}>Cancel</MaterialButton>
            {#if inputs.some((a) => a.id === editing?.id)}
                <MaterialButton variant="outlined" icon="delete" on:click={deleteEditing}>Delete</MaterialButton>
            {/if}
        </div>
    </div>
{/if}

<!-- edit saved inputs / save a mirroring device as an input -->
{#if inputs.length || unassigned.length}
    <div class="chips">
        {#each inputs as input (input.id)}
            <MaterialButton variant="outlined" icon="edit" title="Edit input" on:click={() => edit(input)}>{input.name}</MaterialButton>
        {/each}
        {#each unassigned as session (session.id)}
            <MaterialButton variant="outlined" icon="add" title="Save as an input" on:click={() => edit(null, session)}>Save {session.name}</MaterialButton>
        {/each}
    </div>
{/if}

<!-- saved inputs (cards are direct items of the media grid: Card sizes itself from it) -->
{#each matched as { input, session } (input.id)}
    {#if session}
        {#key session.id}
            <Capture bind:streams screen={{ id: session.id, name: input.name }} on:click={(e) => showInput(e.detail || e, input, session)} />
        {/key}
    {:else}
        <Card label={input.name} title="{input.name}: waiting for {input.device || 'a device'} to mirror" icon="cast" outlineColor={findMatchingOut(input.id, $outputs)} active={findMatchingOut(input.id, $outputs) !== null} on:click={(e) => showInput(e.detail, input, null)}>
            <div class="waiting">Waiting for {input.device || "a device"}…</div>
        </Card>
    {/if}
{/each}

<!-- mirroring sessions without a saved input -->
{#each unassigned as session (session.id)}
    <Capture bind:streams screen={{ id: session.id, name: `${session.name} (${session.receiver})` }} on:click={(e) => clickSession(e.detail || e, session)} />
{/each}

{#if loaded && !sessions.length && !inputs.length}
    <div class="empty">
        <p>Nothing is mirroring yet. Start a receiver on this PC, then mirror your phone, tablet or laptop to it - or create an input so it's ready when the device connects.</p>
        <div class="buttons">
            <MaterialButton variant="outlined" icon="launch" on:click={() => sendMain(Main.OPEN_WIRELESS_RECEIVER, "AirServer")} title="AirPlay, Google Cast and Miracast">AirServer</MaterialButton>
            <MaterialButton variant="outlined" icon="launch" on:click={() => sendMain(Main.OPEN_WIRELESS_RECEIVER, "Wireless Display")} title="Windows' built-in Miracast receiver">Windows Wireless Display</MaterialButton>
        </div>
    </div>
{/if}

<div style="width: 100%;height: 10px;" />

<style>
    .title {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 6px 2px;
    }
    .title p {
        font-weight: 600;
    }
    .title span {
        opacity: 0.6;
        font-size: 0.85em;
    }

    .editor,
    .empty {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        border-radius: var(--radius-md);
        background-color: var(--primary-darker);
    }
    .empty p,
    .hint {
        white-space: normal;
        opacity: 0.75;
        font-size: 0.9em;
    }
    .buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }

    .chips {
        width: 100%;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 2px 6px 6px;
    }

    .waiting {
        width: 100%;
        aspect-ratio: 16/9;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.6;
        font-size: 0.9em;
    }
</style>
