const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// pnpm uses a virtual store with symlinks. Metro needs to:
// 1. Watch the workspace root so it can find packages in the shared node_modules
// 2. Follow symlinks in the pnpm virtual store
// 3. Know where to look for node_modules (both local and workspace root)
config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Enable symlink resolution — required for pnpm on Android
// Without this, Metro cannot resolve assets (fonts, images) from symlinked packages
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
