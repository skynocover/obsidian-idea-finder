const fs = require("fs");
const path = require("path");

const vaultPath = process.env.OBSIDIAN_VAULT;

if (!vaultPath) {
	console.error("\x1b[31m%s\x1b[0m", "Error: OBSIDIAN_VAULT environment variable is not set.");
	console.error("");
	console.error("Please set the environment variable to your Obsidian vault path:");
	console.error("");
	console.error("  \x1b[36mexport OBSIDIAN_VAULT=\"$HOME/Documents/MyVault\"\x1b[0m");
	console.error("");
	console.error("You can add this to your ~/.zshrc or ~/.bashrc for persistence.");
	process.exit(1);
}

// Expand ~ to home directory if present
const expandedVaultPath = vaultPath.replace(/^~/, process.env.HOME || "");

// Check if vault exists
if (!fs.existsSync(expandedVaultPath)) {
	console.error("\x1b[31m%s\x1b[0m", `Error: Vault path does not exist: ${expandedVaultPath}`);
	process.exit(1);
}

const pluginDir = path.join(expandedVaultPath, ".obsidian", "plugins", "idea-finder");
const sourceDir = path.resolve(__dirname, "..");

// Ensure .obsidian/plugins directory exists
const pluginsDir = path.join(expandedVaultPath, ".obsidian", "plugins");
if (!fs.existsSync(pluginsDir)) {
	fs.mkdirSync(pluginsDir, { recursive: true });
	console.log(`Created plugins directory: ${pluginsDir}`);
}

// Remove existing symlink or directory if exists
if (fs.existsSync(pluginDir)) {
	const stats = fs.lstatSync(pluginDir);
	if (stats.isSymbolicLink()) {
		fs.unlinkSync(pluginDir);
		console.log("Removed existing symlink");
	} else {
		console.error("\x1b[31m%s\x1b[0m", `Error: ${pluginDir} exists and is not a symlink.`);
		console.error("Please remove it manually if you want to create a symlink.");
		process.exit(1);
	}
}

// Create symlink
try {
	fs.symlinkSync(sourceDir, pluginDir, "dir");
	console.log("");
	console.log("\x1b[32m%s\x1b[0m", "Successfully linked plugin!");
	console.log("");
	console.log(`  Source: ${sourceDir}`);
	console.log(`  Target: ${pluginDir}`);
	console.log("");
	console.log("\x1b[33m%s\x1b[0m", "Next steps:");
	console.log("  1. Open Obsidian");
	console.log("  2. Settings -> Community plugins -> Turn off Safe mode");
	console.log("  3. Browse installed plugins -> Enable 'Idea Finder'");
	console.log("");
	console.log("For development, run:");
	console.log("  \x1b[36mnpm run dev\x1b[0m");
	console.log("");
} catch (err) {
	console.error("\x1b[31m%s\x1b[0m", "Error creating symlink:", err.message);
	process.exit(1);
}
