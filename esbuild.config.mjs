import esbuild from "esbuild";
import process from "process";

const prod = !process.argv.includes("--watch");

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	// Handle Node.js built-ins that sql.js might need
	platform: "node",
	// But we're in a browser-like environment (Obsidian)
	// So we need to provide polyfills or handle differently
	define: {
		"process.env.NODE_ENV": prod ? '"production"' : '"development"',
	},
});

if (process.argv.includes("--watch")) {
	await context.watch();
	console.log("Watching for changes...");
} else {
	await context.rebuild();
	await context.dispose();
}
