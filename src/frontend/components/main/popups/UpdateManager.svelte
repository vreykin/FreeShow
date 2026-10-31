<script lang="ts">
    import { onMount } from "svelte"
    import { Main } from "../../../../types/IPC/Main"
    import { sendMain } from "../../../IPC/main"
    import { alertUpdates, special, version } from "../../../stores"
    import { getUpdateData, renderChangelogMarkdown } from "../../../utils/checkForUpdates"
    import Loader from "../Loader.svelte"
    import T from "../../helpers/T.svelte"
    import MaterialButton from "../../inputs/MaterialButton.svelte"
    import MaterialToggleSwitch from "../../inputs/MaterialToggleSwitch.svelte"
    import { registerPopupSubmit } from "../../../utils/popup"

    registerPopupSubmit(downloadLatest)

    let loading = true
    let hasError = false
    let latestVersion = ""
    let changelog = ""
    let hasUpdate = false

    function updateSpecial(value: any, key: string) {
        special.update((a) => {
            if (!value) delete a[key]
            else a[key] = value

            return a
        })
    }

    async function checkUpdates() {
        loading = true
        hasError = false
        latestVersion = ""
        changelog = ""
        hasUpdate = false

        try {
            const currentVersion = $version
            const updateData = await getUpdateData(currentVersion)

            latestVersion = updateData.latestVersion
            changelog = renderChangelogMarkdown(updateData.changelog || "")
            hasUpdate = updateData.hasUpdate
        } catch (error) {
            console.warn(error)
            hasError = true
        }

        loading = false
    }

    function downloadLatest() {
        if (!hasUpdate || !latestVersion) return

        // Always this fork's own releases page - freeshow.app serves
        // upstream's official installer, not this fork's build.
        sendMain(Main.URL, "https://github.com/vreykin/FreeShow/releases")
    }

    onMount(checkUpdates)

    $: versionsMatch = !!latestVersion && $version === latestVersion
</script>

<div class="settings">
    <MaterialToggleSwitch label="settings.alert_updates" checked={$alertUpdates} defaultValue={true} on:change={(e) => alertUpdates.set(e.detail)} />

    <MaterialToggleSwitch label="settings.auto_updates" checked={$special.autoUpdates} on:change={(e) => updateSpecial(e.detail, "autoUpdates")} />
</div>

{#if !loading && !versionsMatch && latestVersion}
    <div class="versions">
        <span class="value">v{$version}</span>
        <span class="label" style="color: var(--secondary);font-weight: bold;">→</span>
        <span class="value">v{latestVersion}</span>
    </div>
{/if}

{#if hasUpdate}
    <MaterialButton variant="contained" style="margin-top: 10px;" icon="download" on:click={downloadLatest}>
        <T id="about.download_latest" />
    </MaterialButton>
{:else if !loading && !hasError}
    <div class="versions">
        <span class="label" style="color: var(--secondary);font-weight: bold;">✓</span>
        <span class="value">v{latestVersion}</span>
    </div>
{/if}

{#if loading}
    <div class="loading">
        <Loader />
    </div>
{:else if hasError || hasUpdate}
    <div class="changelog">
        <h3><T id="about.changes" /></h3>

        {#if hasError}
            <p>Error: Could not check for updates right now.</p>
        {:else if changelog}
            <div class="changelog-content">{@html changelog}</div>
        {/if}
    </div>
{/if}

<style>
    .settings {
        display: flex;
        flex-direction: column;
        margin-bottom: 10px;
    }

    .versions {
        display: flex;
        justify-content: center;
        gap: 5px;
        margin-top: 5px;
    }

    .value {
        color: var(--text);
        font-weight: 600;
    }

    .loading {
        margin-top: 15px;
        display: flex;
        justify-content: center;
    }

    .changelog {
        margin-top: 15px;
        padding: 16px;
        background-color: var(--primary-darker);
        border-radius: 8px;
        max-height: 300px;
        overflow-y: auto;
    }

    h3 {
        color: var(--text);
        text-decoration: underline solid var(--secondary);
        margin-bottom: 8px;
    }

    .changelog-content {
        line-height: 1.4;
    }
    .changelog-content :global(h1),
    .changelog-content :global(h2),
    .changelog-content :global(h3),
    .changelog-content :global(h4) {
        color: var(--text);
        margin: 14px 0 6px;
        font-size: 1em;
    }
    .changelog-content :global(h1:first-child),
    .changelog-content :global(h2:first-child),
    .changelog-content :global(h3:first-child),
    .changelog-content :global(h4:first-child) {
        margin-top: 0;
    }
    .changelog-content :global(ul),
    .changelog-content :global(ol) {
        margin: 4px 0;
        padding-inline-start: 22px;
    }
    .changelog-content :global(a) {
        color: var(--secondary);
    }
    .changelog-content :global(code) {
        background-color: var(--primary);
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 0.9em;
    }
    .changelog-content :global(pre) {
        background-color: var(--primary);
        padding: 10px;
        border-radius: 6px;
        overflow-x: auto;
    }
    .changelog-content :global(pre code) {
        background-color: transparent;
        padding: 0;
    }
</style>
