import { Command } from "commander";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as yaml from "yaml";
import fm, { type FrontMatterResult } from "front-matter";
import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { spawn } from "node:child_process";
import { marked } from "marked";
import markedTerminal from "marked-terminal";
import TerminalRenderer from "marked-terminal";
import readline from "node:readline";
import { table } from "table";

const VAULT_PATH = process.env.VAULT_PATH || "./vault";
console.log("VAULT_PATH", VAULT_PATH);

const program = new Command();

const parseObsidianLinks = (content: string) =>
	Array.from(content.matchAll(/\[\[(.*?)(?:\|.*?)?\]\]/g)).map((m) => m[1]);

const parseInlineTags = (content: string) =>
	Array.from(content.matchAll(/(?<!\S)#([a-zA-Z0-9_-]+)/g)).map((m) => m[1]);

const listFiles = async () => {
	const spinner = ora("Listing files...").start();
	try {
		const files: string[] = [];

		const scanDir = async (dir: string) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				const relPath = path.relative(VAULT_PATH, fullPath);

				if (entry.isDirectory() && entry.name !== '.trash' && entry.name !== 'Utilities') {
					await scanDir(fullPath);
				} else if (entry.name.endsWith(".md")) {
					files.push(relPath);
				}
			}
		};

		await scanDir(VAULT_PATH);
		spinner.succeed("Files found");
		console.log(files.join("\n"));
		console.log(chalk.green(`📁 ${files.length} files found`));
        
		const filesWithoutTags = await Promise.all(
			files.map(async (file) => {
				const content = await fs.readFile(path.join(VAULT_PATH, file), "utf-8");
				const { attributes } = fm(content);
				const currentTags = (attributes as { tags?: string[] }).tags || [];
				return currentTags.length === 0;
			})
		);
		const filesWithoutTagsCount = filesWithoutTags.filter(Boolean).length;
		console.log(
			chalk.green(
				`🏷️ ${filesWithoutTagsCount} files without frontmatter tags`
			),
		);
	} catch (error) {
		spinner.fail("Failed to list files");
		console.error(chalk.red("❌ Error:"), error);
	}
};

const updateTags = async (files: string[], tags: string[], replace = false) => {
	const spinner = ora("Updating tags...").start();
	try {
		for (const file of files) {
			const fullPath = path.join(VAULT_PATH, file);
			const content = await fs.readFile(fullPath, "utf-8");
			const { attributes, body } = fm(content);

			const currentTags = (attributes as { tags?: string[] }).tags || [];

			const newTags = replace ? tags : [...new Set([...currentTags, ...tags])];
			const newFrontmatter = {
				...(attributes as object),
				tags: newTags,
			};

			const newContent = `---\n${yaml.stringify(newFrontmatter)}---\n${body}`;
			await fs.writeFile(fullPath, newContent);
		}
		spinner.succeed("Tags updated");
	} catch (error) {
		spinner.fail("Failed to update tags");
		console.error(chalk.red("❌ Error:"), error);
	}
};

// Get all unique tags across files
const getAllTags = async (subpath = "") => {
	const spinner = ora("Getting tags...").start();
	try {
		const tags = new Set<string>();
		const basePath = path.join(VAULT_PATH, subpath);

		const scanDir = async (dir: string) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				if (entry.isDirectory()) {
					await scanDir(fullPath);
				} else if (entry.name.endsWith(".md")) {
					const content = await fs.readFile(fullPath, "utf-8");
					const { attributes } = fm(content);
					const fileTags = Array.isArray(
						(attributes as { tags?: string[] }).tags,
					)
						? (attributes as { tags?: string[] }).tags
						: [];
					if (fileTags) {
						for (const tag of fileTags) {
							tags.add(tag);
						}
					}
				}
			}
		};

		await scanDir(basePath);
		spinner.succeed("Tags found");
		console.log(Array.from(tags).join(", "));
	} catch (error) {
		spinner.fail("Failed to get tags");
		console.error(chalk.red("❌ Error:"), error);
	}
};

const addTagToSubpath = async (
	subpath: string,
	tag: string,
	replace = false,
) => {
	const spinner = ora("Adding tag to files...").start();
	try {
		const basePath = path.join(VAULT_PATH, subpath);

		const scanDir = async (dir: string) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);

				if (entry.isDirectory()) {
					await scanDir(fullPath);
				} else if (entry.name.endsWith(".md")) {
					const content = await fs.readFile(fullPath, "utf-8");
					const { attributes, body } = fm(content);

					const currentTags = (attributes as { tags?: string[] }).tags || [];

					const newTags = replace ? [tag] : [...new Set([...currentTags, tag])];
					const newFrontmatter = {
						...(attributes as object),
						tags: newTags,
					};

					const newContent = `---\n${yaml.stringify(newFrontmatter)}---\n${body}`;
					await fs.writeFile(fullPath, newContent);
				}
			}
		};

		await scanDir(basePath);
		spinner.succeed("Tag added to files");
	} catch (error) {
		spinner.fail("Failed to add tag");
		console.error(chalk.red("❌ Error:"), error);
	}
};

const searchContent = async (query: string) => {
	const spinner = ora("Searching content...").start();
	try {
		const { execSync } = require("node:child_process");
		const results: {
			title: string;
			path: string;
			matches: string[];
			tags: undefined | string[];
			date: string;
			lastmod: string;
			filePath: string;
		}[] = [];

		const rgCommand = `rg -i -n "${query}" "${VAULT_PATH}" --glob "*.md"`;
		const output = execSync(rgCommand, { encoding: "utf-8" });
		for (const line of output.split("\n")) {
			if (line) {
				const [filePath, lineNumber, match] = line.split(":", 3);
				const relPath = path.relative(VAULT_PATH, filePath);
				const title = path.basename(relPath, ".md");
				const existingResult = results.find((r) => r.path === relPath);
				if (existingResult) {
					existingResult.matches.push(match.trim());
				} else {
					const content = await fs.readFile(filePath, "utf-8");
					const { attributes } = fm(content);
					const tags = Array.isArray((attributes as { tags?: string[] }).tags)
						? (attributes as { tags?: string[] }).tags
						: [];
					const date = (attributes as { date?: string }).date || "";
					const lastmod = (attributes as { lastmod?: string }).lastmod || "";
					results.push({
						title,
						path: relPath,
						matches: [match.trim()],
						tags,
						date,
						lastmod,
						filePath, 
					});
				}
			}
		}

		spinner.succeed("Search completed");

		const displayResults = async () => {
			console.clear();
			console.log(chalk.bold("Search Results:"));

			const displayOptions = [
				{ name: "List view", value: "list" },
				{ name: "Table view", value: "table" },
			];

			const { displayChoice } = await inquirer.prompt([
				{
					type: "list",
					name: "displayChoice",
					message: "Choose display format:",
					choices: displayOptions,
				},
			]);

			if (displayChoice === "table") {
				const tableData = [
					["Title", "Path", "Tags", "Date", "Last Modified"],
					...results.map((result) => [
						result.title,
						result.path,
						Array.isArray(result.tags) ? result.tags.join(", ") : "",
						result.date ? new Date(result.date).toLocaleDateString() : "",
						result.lastmod,
					]),
				];
				console.log(table(tableData));
				console.log("\nPress any key to return to menu...");
				process.stdin.setRawMode(true);
				process.stdin.resume();
				process.stdin.setEncoding("utf8");
				process.stdin.once("data", () => {
					process.stdin.setRawMode(false);
					process.stdin.pause();
					displayResults();
				});
				return;
			}

			results.forEach((result, index) => {
				console.log(
					`${index + 1}. ${result.title} (${result.matches.length} matches)`,
				);
				console.log(`   Tags: ${result.tags?.join(", ") || "No tags"}`);
				console.log(`   Date: ${result.date}`);
				console.log(`   Last Modified: ${result.lastmod}`);
			});

			console.log(
				"\nNavigate with arrow keys, press Enter to select, or type a number and press Enter.",
			);
			console.log("Press 'q' to quit, 'm' to return to main menu.");

			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});

			let selectedIndex = 0;

			const renderCursor = () => {
				process.stdout.write("\x1B[1;1H\x1B[J");
				console.log(chalk.bold("Search Results:"));

				results.forEach((result, index) => {
					if (index === selectedIndex) {
						console.log(
							chalk.cyan(
								`> ${index + 1}. ${result.title} (${result.matches.length} matches)`,
							),
						);
						console.log(
							chalk.cyan(`   Tags: ${result.tags?.join(", ") || "No tags"}`),
						);
						console.log(chalk.cyan(`   Date: ${result.date}`));
						console.log(chalk.cyan(`   Last Modified: ${result.lastmod}`));
					} else {
						console.log(
							`  ${index + 1}. ${result.title} (${result.matches.length} matches)`,
						);
						console.log(`   Tags: ${result.tags?.join(", ") || "No tags"}`);
						console.log(`   Date: ${result.date}`);
						console.log(`   Last Modified: ${result.lastmod}`);
					}
				});

				console.log(
					"\nNavigate with arrow keys, press Enter to select, or type a number and press Enter.",
				);
				console.log("Press 'q' to quit, 'm' to return to main menu.");
			};

			renderCursor();

			process.stdin.setRawMode(true);
			process.stdin.resume();
			process.stdin.setEncoding("utf8");
			return new Promise((resolve) => {
				let inputBuffer = "";
				const handleKeyPress = async (key: Buffer) => {
					try {
						const keyStr = key.toString();
						if (keyStr === "\u001B[A" && selectedIndex > 0) {
							// Up arrow
							selectedIndex--;
							renderCursor();
						} else if (
							keyStr === "\u001B[B" &&
							selectedIndex < results.length - 1
						) {
							// Down arrow
							selectedIndex++;
							renderCursor();
						} else if (keyStr === "\r") {
							// Enter
							if (inputBuffer) {
								const index = Number.parseInt(inputBuffer) - 1;
								if (index >= 0 && index < results.length) {
									selectedIndex = index;
								}
								inputBuffer = "";
							}
							process.stdin.removeListener("data", handleKeyPress);
							process.stdin.setRawMode(false);
							process.stdin.pause();
							rl.close();
							await handleSelectedResult(results[selectedIndex]);
							await displayResults(); 
						} else if (keyStr === "q") {
							process.exit(0);
						} else if (keyStr === "m") {
							process.stdin.removeListener("data", handleKeyPress);
							process.stdin.setRawMode(false);
							process.stdin.pause();
							rl.close();
							resolve(null);
						} else if (keyStr >= "0" && keyStr <= "9") {
							inputBuffer += keyStr;
							const index = Number.parseInt(inputBuffer) - 1;
							if (index >= 0 && index < results.length) {
								selectedIndex = index;
								renderCursor();
							}
						} else {
							inputBuffer = "";
						}
					} catch (error) {
						console.error("An error occurred:", error);
						process.stdin.removeListener("data", handleKeyPress);
						process.stdin.setRawMode(false);
						process.stdin.pause();
						rl.close();
						resolve(null);
					}
				};

				process.stdin.on("data", handleKeyPress);
			});
		};

		const handleSelectedResult = async (
			selectedResult: (typeof results)[0],
		) => {
			console.clear();
			console.log(chalk.bold(`\nFile: ${selectedResult.title}`));
			console.log(chalk.gray(`Path: ${selectedResult.path}`));
			console.log(chalk.yellow("\nMatches:"));
			selectedResult.matches.forEach((match, index) => {
				console.log(chalk.green(`  ${index + 1}. ${match}`));
			});

			const displayMenu = () => {
				console.log("\nOptions:");
				console.log("o: Open in editor");
				console.log("p: Preview content");
				console.log("r: Return to results");
				console.log("m: Return to main menu");
				console.log("Press any key to show menu");
			};

			displayMenu();

			return new Promise<void>((resolve) => {
				const handleKeyPress = (key: Buffer) => {
					const keyStr = key.toString();
					console.clear();
					console.log(chalk.bold(`\nFile: ${selectedResult.title}`));
					console.log(chalk.gray(`Path: ${selectedResult.path}`));
					console.log(chalk.yellow("\nMatches:"));
					selectedResult.matches.forEach((match, index) => {
						console.log(chalk.green(`  ${index + 1}. ${match}`));
					});

					switch (keyStr.toLowerCase()) {
						case "o":
							process.stdin.removeListener("data", handleKeyPress);
							process.stdin.setRawMode(false);
							process.stdin.pause();
							openInEditor(selectedResult.path).then(resolve);
							break;
						case "p":
							process.stdin.removeListener("data", handleKeyPress);
							process.stdin.setRawMode(false);
							process.stdin.pause();
							previewContent(selectedResult.path).then(() => {
								console.log("\nPress any key to return to menu...");
								process.stdin.setRawMode(true);
								process.stdin.resume();
								process.stdin.setEncoding("utf8");
								process.stdin.once("data", () => {
									console.clear();
									process.stdin.setRawMode(true);
									process.stdin.resume();
									process.stdin.setEncoding("utf8");
									process.stdin.on("data", handleKeyPress);
									displayMenu();
								});
							});
							break;
						case "r":
							process.stdin.removeListener("data", handleKeyPress);
							process.stdin.setRawMode(false);
							process.stdin.pause();
							resolve();
							break;
						case "m":
							process.stdin.removeListener("data", handleKeyPress);
							process.stdin.setRawMode(false);
							process.stdin.pause();
							resolve();
							break;
						case "\u0003": // Ctrl+C
							process.exit();
							break;
						default:
							displayMenu();
							break;
					}
				};

				process.stdin.setRawMode(true);
				process.stdin.resume();
				process.stdin.setEncoding("utf8");
				process.stdin.on("data", handleKeyPress);
			});
		};

		const openInEditor = async (filePath: string) => {
			const editor = process.env.EDITOR || "vim";
			const fullPath = path.join(VAULT_PATH, filePath);
			const child = spawn(editor, [fullPath], {
				stdio: "inherit",
			});
			await new Promise((resolve) => {
				child.on("exit", resolve);
			});
			const selectedResult = results.find((r) => r.path === filePath);
			if (selectedResult) {
				await handleSelectedResult(selectedResult);
			} else {
				console.log(
					"File not found in search results. Returning to main menu.",
				);
				await mainMenu();
			}
		};

		const previewContent = async (filePath: string) => {
			const fullPath = path.join(VAULT_PATH, filePath);
			try {
				const content = await fs.readFile(fullPath, "utf-8");

				const processObsidianSyntax = (text: string) => {
					// Style wiki links [[...]]
					return (
						text
							.replace(/\[\[(.*?)\]\]/g, (_, p1) => {
								const [link, alias] = p1.split("|");
								return `[${alias || link}](${link})`;
							})
							// Style tags #tag
							.replace(/(?<!\S)#([a-zA-Z0-9_-]+)/g, "`#$1`")
							// Style front matter
							.replace(
								/^---\n([\s\S]*?)\n---/,
								(match) => `\`\`\`yaml\n${match.slice(4, -4)}\n\`\`\``,
							)
					);
				};

				const TerminalRenderer = markedTerminal;
				const renderer = new TerminalRenderer({
					code: chalk.cyan, 
					blockquote: chalk.gray.italic,
					html: chalk.gray,
					heading: chalk.green.bold,
					firstHeading: chalk.magenta.underline.bold,
					hr: chalk.reset,
					listitem: chalk.reset,
					table: chalk.reset,
					paragraph: chalk.reset,
					strong: chalk.bold,
					em: chalk.italic,
					codespan: chalk.cyan,
					del: chalk.dim.gray.strikethrough,
					link: chalk.blue,
					href: chalk.blue.underline, 
					width: process.stdout.columns,
					reflowText: true,

					showSectionPrefix: true,
					unescape: true,
					emoji: true,

					tab: 2,
				});

				const options = {
					renderer: renderer as unknown as typeof marked.Renderer,
				};

				marked.setOptions(options);
				console.clear();
				console.log(`\n${chalk.bold.underline("File Preview:")}\n`);
				console.log(marked(processObsidianSyntax(content)));
				console.log("\n");

				console.log("Press any key to return...");
				process.stdin.setRawMode(true);
				process.stdin.resume();
				process.stdin.once("data", () => {
					process.stdin.setRawMode(false);
					process.stdin.pause();
				});
			} catch (error) {
				console.error(chalk.red("Error reading file:"), error);
				console.log("Press any key to return to main menu...");
				process.stdin.setRawMode(true);
				process.stdin.resume();
				process.stdin.once("data", () => {
					process.stdin.setRawMode(false);
					process.stdin.pause();
					mainMenu();
				});
			}
		};

		await displayResults();
	} catch (error) {
		spinner.fail("Failed to search content");
		console.error(chalk.red("❌ Error:"), error);
		console.log("Press any key to return to main menu...");
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode(false);
			process.stdin.pause();
			mainMenu();
		});
	}
};

const listBacklinks = async (filePath: string) => {
	const spinner = ora("Finding backlinks...").start();
	try {
		const backlinks: { path: string; context: string }[] = [];

		const scanDir = async (dir: string) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				const relPath = path.relative(VAULT_PATH, fullPath);

				if (entry.isDirectory()) {
					await scanDir(fullPath);
				} else if (entry.name.endsWith(".md")) {
					const content = await fs.readFile(fullPath, "utf-8");
					const links = parseObsidianLinks(content);
					if (links.includes(path.basename(filePath, ".md"))) {
						const context =
							content
								.split("\n")
								.find((line) =>
									line.includes(`[[${path.basename(filePath, ".md")}]]`),
								) || "";
						backlinks.push({ path: relPath, context });
					}
				}
			}
		};

		await scanDir(VAULT_PATH);
		spinner.succeed("Backlinks found");
		console.log(JSON.stringify(backlinks, null, 2));
	} catch (error) {
		spinner.fail("Failed to find backlinks");
		console.error(chalk.red("❌ Error:"), error);
	}
};

const mainMenu = async () => {
	const { action } = await inquirer.prompt([
		{
			type: "list",
			name: "action",
			message: "What would you like to do?",
			choices: [
				{ name: "List all markdown files", value: "list" },
				{ name: "Update tags for multiple files", value: "update-tags" },
				{ name: "Get all unique tags across files", value: "tags" },
				{
					name: "Add a tag to all files in a specific subpath",
					value: "add-tag",
				},
				{ name: "Search content across files", value: "search" },
				{ name: "List backlinks for a file", value: "backlinks" },
				{ name: "Exit", value: "exit" },
			],
		},
	]);

	switch (action) {
		case "list":
			await listFiles();
			break;
		case "update-tags":
			{
				const updateAnswers = await inquirer.prompt([
					{
						type: "input",
						name: "files",
						message: "Enter file paths (comma-separated):",
						filter: (input: string) =>
							input.split(",").map((file) => file.trim()),
					},
					{
						type: "input",
						name: "tags",
						message: "Enter tags to set (comma-separated):",
						filter: (input: string) =>
							input.split(",").map((tag) => tag.trim()),
					},
					{
						type: "confirm",
						name: "replace",
						message: "Replace existing tags instead of appending?",
						default: false,
					},
				]);
				if (updateAnswers.replace) {
					console.log(
						chalk.yellow("⚠️  Warning: Existing tags will be replaced!"),
					);
				}
				await updateTags(
					updateAnswers.files,
					updateAnswers.tags,
					updateAnswers.replace,
				);
			}
			break;
		case "tags":
			{
				const tagsAnswer = await inquirer.prompt([
					{
						type: "input",
						name: "path",
						message: "Enter subpath within the vault (optional):",
						default: "",
					},
				]);
				await getAllTags(tagsAnswer.path);
			}
			break;
		case "add-tag":
			{
				const addTagAnswers = await inquirer.prompt([
					{
						type: "input",
						name: "path",
						message: "Enter subpath within the vault:",
						validate: (input: string) =>
							input.length > 0 || "Subpath is required",
					},
					{
						type: "input",
						name: "tag",
						message: "Enter tag to add:",
						validate: (input: string) => input.length > 0 || "Tag is required",
					},
					{
						type: "confirm",
						name: "replace",
						message: "Replace existing tags instead of appending?",
						default: false,
					},
				]);
				if (addTagAnswers.replace) {
					console.log(
						chalk.yellow("⚠️  Warning: Existing tags will be replaced!"),
					);
				}
				await addTagToSubpath(
					addTagAnswers.path,
					addTagAnswers.tag,
					addTagAnswers.replace,
				);
			}
			break;
		case "search":
			{
				const searchAnswer = await inquirer.prompt([
					{
						type: "input",
						name: "query",
						message: "Enter search query:",
						validate: (input: string) =>
							input.length > 0 || "Search query is required",
					},
				]);
				await searchContent(searchAnswer.query);
			}
			break;
		case "backlinks":
			{
				const backlinksAnswer = await inquirer.prompt([
					{
						type: "input",
						name: "file",
						message: "Enter file path to find backlinks for:",
						validate: (input: string) =>
							input.length > 0 || "File path is required",
					},
				]);
				await listBacklinks(backlinksAnswer.file);
			}
			break;
		case "exit":
			console.log("Goodbye!");
			process.exit(0);
	}

	await mainMenu();
};

mainMenu().catch((error) => {
	console.error(chalk.red("An error occurred:"), error);
	process.exit(1);
});
