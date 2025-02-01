import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { sleep } from './utils';
import * as fs from 'node:fs';
import * as path from 'node:path';

const API_KEY = 'API_KEY';

interface TextContent {
	type: 'text';
	text: string;
}

interface ImageContent {
	type: 'image';
	source: {
		type: 'base64';
		media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
		data: string;
	};
}

interface DocumentContent {
	type: 'document';
	source: {
		type: 'base64';
		media_type: 'application/pdf';
		data: string;
	};
}

type ContentBlock = TextContent | ImageContent | DocumentContent;

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

interface AnthropicResponse {
	content: { text: string; type: string }[];
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

async function main(
	model: string,
	prompts: string[],
	properties: Record<string, unknown>,
	settings: Record<string, unknown>,
) {
	const total = prompts.length;
	const { prompt, ...restProperties } = properties;
	const anthropic = new Anthropic({ apiKey: settings?.[API_KEY] as string });
	const systemPrompt = (prompt ||
		config.properties.find((prop) => prop.id === 'prompt')?.value) as string;
	const messageHistory: Message[] = [];
	const outputs: (ChatCompletion | ErrorCompletion)[] = [];

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

			let retries = 3; // Maximum number of retries
			let response;
			do {
				try {
					response = (await anthropic.messages.create({
						model: model,
						system: systemPrompt,
						max_tokens: 4096,
						messages: messageHistory,
						...restProperties,
					})) as AnthropicResponse;

					// Process the successful response
					const assistantResponse = response.content
						.map((content) => content.text)
						.join('\n');
					const inputTokens = response.usage.input_tokens;
					const outputTokens = response.usage.output_tokens;
					messageHistory.push({
						role: 'assistant',
						content: [
							{
								type: 'text',
								text: assistantResponse,
							},
						],
					});

					outputs.push({
						output: assistantResponse,
						stats: { model, inputTokens, outputTokens },
					});
					console.log(`Response to prompt: ${prompt}`, assistantResponse);
					break; // Exit the loop on success
				} catch (error) {
					if (error.status === 429 && retries > 0) {
						// Rate limit error: Wait and retry
						console.warn('Rate limit exceeded, retrying...');
						await sleep(3000); // Wait for 3 seconds
						retries--;
					} else {
						const completionWithError = mapErrorToCompletion(error, model);
						outputs.push(completionWithError);
						// Other errors or retries exhausted
						console.error('Error:', error);
						throw error;
					}
				}
			} while (retries > 0);
		}
		return mapToResponse(outputs, model);
	} catch (error) {
		console.error('Error in main function:', error);
		throw error;
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
