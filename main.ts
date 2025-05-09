import * as fs from 'node:fs';
import * as path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { config } from './config.js';
import { sleep } from './utils';

const API_KEY = 'API_KEY';

/**
 * Represents a text content block in a message
 */
interface TextContent {
	type: 'text';
	text: string;
}

/**
 * Represents an image content block in a message
 */
interface ImageContent {
	type: 'image';
	source: {
		type: 'base64';
		media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
		data: string;
	};
}

/**
 * Represents a document content block in a message
 */
interface DocumentContent {
	type: 'document';
	source: {
		type: 'base64';
		media_type: 'application/pdf';
		data: string;
	};
}

interface ToolResultContent {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
};

/**
 * Represents a thinking content block in a response
 */
interface ThinkingContent {
	type: 'thinking';
	thinking: string;
	signature: string;
}

interface ToolUseContent {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, unknown>;
}

type ContentBlock = 
	|TextContent
	| ImageContent
	| DocumentContent
	| ToolResultContent
	| ToolUseContent;

type ResponseContentBlock = TextContent | ThinkingContent;

interface Message {
	role: 'user' | 'assistant';
	content: ContentBlock[];
}

interface Completion {
	Content: string | null;
	TokenUsage: number | undefined;
}

interface ConnectorResponse {
	Completions: Completion[];
	ModelType: string;
}

interface ChatCompletion {
	output: string;
	stats: { model: string; inputTokens: number; outputTokens: number };
}

/**
 * Configuration for the thinking feature
 */
interface ThinkingConfig {
	type: 'enabled';
	budget_tokens: number;
}

/**
 * Response from the Anthropic API
 */
interface AnthropicResponse {
	content: (TextContent | ThinkingContent | ToolUseContent)[];
	id: string;
	model: string;
	role: string;
	stop_reason: string;
	stop_sequence: string | null;
	type: string;
	usage: {
		input_tokens: number;
		output_tokens: number;
	};
}

interface ErrorCompletion {
	output: '';
	error: string;
	model: string;
	usage: undefined;
}

const mapToResponse = (
	outputs: (ChatCompletion | ErrorCompletion)[],
	model: string,
): ConnectorResponse => {
	return {
		Completions: outputs.map((output) => {
			if ('error' in output) {
				return {
					Content: null,
					TokenUsage: undefined,
					Error: output.error,
				};
			}

			return {
				Content: output.output,
				TokenUsage: output.stats.inputTokens + output.stats.outputTokens,
			};
		}),
		ModelType: outputs.length
			? 'error' in outputs[0]
				? model
				: outputs[0].stats.model
			: model,
	};
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapErrorToCompletion = (error: any, model: string): ErrorCompletion => {
	const errorMessage = error.message || JSON.stringify(error);
	return {
		output: '',
		error: errorMessage,
		model,
		usage: undefined,
	};
};

interface MCPServerConfig {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

interface MCPClient {
	client: Client;
	tools: {
		name: string;
		description?: string;
		input_schema: any;
	}[];
}

async function initializeMCPClients(mcpServers: Record<string, MCPServerConfig>) {
	const clients: Record<string, MCPClient> = {};
	for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
		const client = new Client({ name: `mcp-client-${serverName}`, version: "1.0.0" });
		const transport = new StdioClientTransport({			
			...serverConfig,
      env: {
        ...serverConfig.env,
        PATH: process.env.PATH ?? ''
      }
		});
		await client.connect(transport);
		const toolsResult = await client.listTools();

		const normalizedServerName = serverName.replace(/_/g, '-');
		
		clients[normalizedServerName] = {
			client,
			tools: toolsResult.tools.map((tool) => ({
				name: `${normalizedServerName}_${tool.name}`,
				description: tool.description,
				input_schema: tool.inputSchema,
			})),
		};
	}
	return clients;
}

const callTool  = async (content: ToolUseContent, clients: Record<string, MCPClient>) => {
	const [serverName, ...rest] = content.name.split('_');
	const toolName = rest.join('_');
	const client = clients[serverName]?.client;
	if (!client) {
		throw new Error(`Client for server ${serverName} not found`);
	}

	const result = await client.callTool({
		name: toolName,
		arguments: content.input,
	});

	return result;
}
interface APIParams {
	model: string;
	system: string;
	max_tokens: number;
	tools: {
		name: string;
		description?: string;
		input_schema: any;
	}[];
}

async function processModelRequest(
	anthropic: Anthropic,
	apiParams: APIParams,
	mcpClients: Record<string, MCPClient>,
	messageHistory: Message[],
	model: string,
	outputs = [] as (ChatCompletion | ErrorCompletion)[],
	retries = 3
): Promise<(ChatCompletion | ErrorCompletion)[]> {
	try {
		const response = (await anthropic.messages.create(
			{ ...apiParams, messages: messageHistory },
		)) as AnthropicResponse;
		
		let assistantResponse = '';
		let thinkingContent = '';
		let inputTokens = response.usage.input_tokens;
		let outputTokens = response.usage.output_tokens;

		const toolUsePromises: Promise<void>[] = [];

		for (const content of response.content) {
			if (content.type === 'text') {
				assistantResponse += content.text;
			} else if (content.type === 'thinking') {
				thinkingContent += (content as ThinkingContent).thinking + '\n';
			} else if (content.type === 'tool_use') {
				messageHistory.push({
					role: 'assistant',
					content: [content],
				});

				const res = '\n\nCalling tool:\n\n```json\n' + JSON.stringify(content, null, 2) + '\n```\n\n';
				assistantResponse += res;

				const toolPromise = (async () => {
					const result = await callTool(content, mcpClients);
				
					const toolCollingResult = '\n\nTool calling result:\n\n```json\n' + JSON.stringify(result, null, 2) + '\n```\n\n';
					assistantResponse += toolCollingResult;

					messageHistory.push({
						role: 'user',
						content: [
							{
								type: 'tool_result',
								tool_use_id: content.id,
								content: JSON.stringify(result),
							},
						],
					});
				})();

				toolUsePromises.push(toolPromise);
			}
		}

		await Promise.all(toolUsePromises);

		const finalOutput = thinkingContent
		? `${thinkingContent}\n${assistantResponse}`
		: assistantResponse;

		outputs.push({
			output: finalOutput,
			stats: { model, inputTokens, outputTokens },
		});

		if (toolUsePromises.length > 0) {
			return await processModelRequest(anthropic, apiParams, mcpClients, messageHistory, model, outputs);
		}

		return outputs;
	} catch (error) {
		if (error.status === 429 && retries > 0) {
			console.warn('Rate limit exceeded, retrying...');
			await sleep(3000); 
			return await processModelRequest(anthropic, apiParams, mcpClients, messageHistory, model, outputs, retries - 1);
		} else {
			const completionWithError = mapErrorToCompletion(error, model);			
			outputs.push(completionWithError);
			console.error('Error:', error);
			return outputs;
		}
	}
}

/**
 * Main function to process prompts and generate completions
 * 
 * @param model - The model to use for generation
 * @param prompts - Array of prompts to process
 * @param properties - Configuration properties for the model
 * @param settings - API settings
 * @returns A connector response with completions
 */
async function main(
	model: string,
	prompts: string[],
	properties: Record<string, unknown>,
	settings: Record<string, unknown>,
) {
	const total = prompts.length;
	const { prompt, thinking, tools, ...restProperties } = properties as {
		prompt?: string;
		thinking?: number;
		tools?: {
			mcpServers?: Record<string, MCPServerConfig>;
		};
	};
	const anthropic = new Anthropic({ apiKey: settings?.[API_KEY] as string });
	const systemPrompt = (prompt ||
		config.properties.find((prop) => prop.id === 'prompt')?.value) as string;
	const messageHistory: Message[] = [];

	const mcpClients = tools?.mcpServers ? await initializeMCPClients(tools.mcpServers) : {};
	const allTools = Object.values(mcpClients).flatMap(client => client.tools);
	
	// Check if model supports thinking feature (only Claude 3.7 Sonnet models)
	const supportsThinking = model.startsWith('claude-3-7-sonnet-');

	try {
		for (let index = 0; index < total; index++) {
			const userPrompt = prompts[index];
			const { imageUrls, pdfUrls } = extractUrls(userPrompt);
			const messageContent: ContentBlock[] = [
				{ type: 'text', text: userPrompt },
			];

			for (const imageUrl of imageUrls) {
				const base64Image = encodeImage(imageUrl);

				messageContent.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: base64Image.ext,
						data: base64Image.data,
					},
				});
			}

			for (const pdfUrl of pdfUrls) {
				const base64PDF = encodePDF(pdfUrl);

				messageContent.push({
					type: 'document',
					source: {
						type: 'base64',
						media_type: 'application/pdf',
						data: base64PDF.data,
					},
				});
			}

			messageHistory.push({
				role: 'user',
				content: messageContent,
			});

			const apiParams = {
				model: model,
				system: systemPrompt,
				max_tokens: 4096,
				tools: allTools,
				...restProperties,
			};
			
			if (supportsThinking && thinking) {
				// @ts-ignore - Anthropic SDK types may not include thinking yet
				apiParams.thinking = {
					type: 'enabled',
					budget_tokens: Number(thinking)
				};
			}

			const outputs = await processModelRequest(anthropic, apiParams, mcpClients, messageHistory, model);
			return mapToResponse(outputs, model);
		}
	} catch (error) {
		console.error('Error in main function:', error);
		throw error;
	} finally {
		for (const client of Object.values(mcpClients)) {
				await client.client.close();
		}
}
}

function encodePDF(pdfPath: string): {
	data: string;
} {
	const pdfBuffer = fs.readFileSync(pdfPath);
	return {
		data: pdfBuffer.toString('base64'),
	};
}

function encodeImage(imagePath: string): {
	ext: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
	data: string;
} {
	const ext = path.extname(imagePath).slice(1);
	const imageBuffer = fs.readFileSync(imagePath);
	return {
		ext: `image/${ext}` as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
		data: imageBuffer.toString('base64'),
	};
}

function extractUrls(prompt: string): { imageUrls: string[]; pdfUrls: string[] } {
	const imageExtensions = ['.png', '.jpeg', '.jpg', '.webp', '.gif'];
	const pdfExtension = '.pdf';
	// Updated regex to match both http and local file paths
	const urlRegex =
		/(https?:\/\/[^\s]+|"[^"]+"|'[^']+\'|[a-zA-Z]:\\[^:<>"|?\s\n]*|\/[^:<>"|?\s\n]*)/g;
	const urls = prompt.match(urlRegex) || [];

	const result = {
		imageUrls: [] as string[],
		pdfUrls: [] as string[],
	};

	for (let url of urls) {
		// Remove single or double quotes if present
		url = url.replace(/^['"]|['"]$/g, '');
		const extensionIndex = url.lastIndexOf('.');
		if (extensionIndex === -1) continue;
		
		const extension = url.slice(extensionIndex).toLowerCase();
		if (imageExtensions.includes(extension)) {
			result.imageUrls.push(url);
		} else if (extension === pdfExtension) {
			result.pdfUrls.push(url);
		}
	}

	return result;
}

export { main, config };
