<script lang="ts">
    import Window from "./Window.svelte"

    // A receiver's mirroring window: its title bar and borders are cropped off, and the picture inside
    // (16:9 for AirPlay/Miracast mirroring) fills the output.

    export let id: string
    export let crop: { top: number; left: number; right: number; bottom: number } | undefined = undefined

    $: c = crop || { top: 0, left: 0, right: 0, bottom: 0 }
    $: visibleWidth = Math.max(0.2, 1 - c.left - c.right)
    $: visibleHeight = Math.max(0.2, 1 - c.top - c.bottom)
    $: videoStyle = `position: absolute;width: ${100 / visibleWidth}%;height: ${100 / visibleHeight}%;left: ${(-c.left / visibleWidth) * 100}%;top: ${(-c.top / visibleHeight) * 100}%;object-fit: fill;`
</script>

<div class="frame">
    <Window {id} style={videoStyle} on:loaded />
</div>

<style>
    .frame {
        position: absolute;
        inset: 0;
        overflow: hidden;
    }
</style>
