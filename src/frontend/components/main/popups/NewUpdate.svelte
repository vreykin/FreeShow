<script lang="ts">
    import { Main } from "../../../../types/IPC/Main"
    import { sendMain } from "../../../IPC/main"
    import { activePopup, popupData, special } from "../../../stores"
    import { renderChangelogMarkdown } from "../../../utils/checkForUpdates"
    import T from "../../helpers/T.svelte"
    import HRule from "../../input/HRule.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import { registerPopupSubmit } from "../../../utils/popup"

    registerPopupSubmit(download)

    let changelog = renderChangelogMarkdown($popupData.changelog || "")

    function download() {
        // Always this fork's own releases page - freeshow.app serves
        // upstream's official installer, not this fork's build.
        sendMain(Main.URL, "https://github.com/vreykin/FreeShow/releases")

        activePopup.set(null)
        popupData.set({})
    }
</script>

{#if $special.autoUpdates}
    <div class="auto_update">
        <T id="about.download_auto" />
    </div>

    <HRule title="setup.or" />
{/if}

<MaterialButton variant="contained" icon="download" on:click={download}>
    <T id="about.download_latest" />
</MaterialButton>

<div class="changelog">
    <h3 style="color: var(--text);text-decoration: underline solid var(--secondary);"><T id="about.changes" /></h3>
    {@html changelog}
</div>

<style>
    .auto_update {
        max-width: 650px;
        font-size: 0.9em;
    }

    .changelog {
        margin-top: 20px;
        max-height: 300px;
        overflow-y: auto;

        padding: 20px;
        background-color: var(--primary-darker);
        border-radius: 8px;
    }

    /* rendered release-note markdown */
    .changelog :global(h1),
    .changelog :global(h2),
    .changelog :global(h3),
    .changelog :global(h4) {
        color: var(--text);
        margin: 14px 0 6px;
        font-size: 1em;
    }
    .changelog :global(h1:first-child),
    .changelog :global(h2:first-child),
    .changelog :global(h3:first-child),
    .changelog :global(h4:first-child) {
        margin-top: 0;
    }
    .changelog :global(ul),
    .changelog :global(ol) {
        margin: 4px 0;
        padding-inline-start: 22px;
    }
    .changelog :global(a) {
        color: var(--secondary);
    }
    .changelog :global(code) {
        background-color: var(--primary);
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 0.9em;
    }
    .changelog :global(pre) {
        background-color: var(--primary);
        padding: 10px;
        border-radius: 6px;
        overflow-x: auto;
    }
    .changelog :global(pre code) {
        background-color: transparent;
        padding: 0;
    }
</style>
