<script lang="ts">
    import { createEventDispatcher, onDestroy, onMount } from "svelte"
    import { Main } from "../../../../types/IPC/Main"
    import { requestMain, sendMain } from "../../../IPC/main"
    import Icon from "../../helpers/Icon.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import Capture from "./Capture.svelte"

    // AirPlay / Google Cast / Miracast, received by AirServer, UxPlay or Windows' Wireless Display
    // and captured from their mirroring window (see electron/wireless/wirelessSources.ts)

    export let streams: MediaStream[]

    type Receiver = "AirServer" | "UxPlay" | "Wireless Display"
    let sources: { name: string; id: string; receiver: Receiver }[] = []
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
        const list = (await requestMain(Main.GET_WIRELESS_SOURCES)) || []
        loaded = true
        // keep the same objects when nothing changed, so running captures aren't restarted
        if (JSON.stringify(list) !== JSON.stringify(sources)) sources = list
    }

    let dispatch = createEventDispatcher()
    function click(event: any, screen: { name: string; id: string }) {
        dispatch("click", { event, screen })
    }
</script>

<div class="title">
    <Icon id="cast" white />
    <p>Wireless</p>
    <span>AirPlay · Google Cast · Miracast</span>
</div>

{#each sources as source (source.id)}
    <Capture bind:streams screen={{ id: source.id, name: source.receiver === "Wireless Display" ? "Wireless Display" : `${source.name} (${source.receiver})` }} on:click={(e) => click(e.detail || e, { id: source.id, name: source.name })} />
{/each}

{#if loaded && !sources.length}
    <div class="empty">
        <p>Nothing is mirroring yet. Start a receiver on this PC, then mirror your phone, tablet or laptop to it.</p>
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

    .empty {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 8px 10px;
        border-radius: var(--radius-md);
        background-color: var(--primary-darker);
    }
    .empty p {
        white-space: normal;
        opacity: 0.8;
    }
    .buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }
</style>
