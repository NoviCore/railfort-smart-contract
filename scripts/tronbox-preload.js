// TronBox 4.8 requires a `window` global (browser assumption in graphlib dependency).
// This preload sets it so the node process doesn't crash.
global.window = {};
