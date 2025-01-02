import { Client, GraphError } from '@microsoft/microsoft-graph-client';
import PQueue from 'p-queue';
import { v4 as uuid4 } from 'uuid';
import { createLogger, format, Logger, transports } from 'winston';

interface BatchRequest<T> {
	id: string;
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	url: string;
	body?: T;
	headers?: Record<string, string>;
}

interface BatchResponse<T> {
	id: string;
	status: number;
	body?: T & { error?: { message: string; code: string } };
}

interface BatchResult<T, R> {
	successful: { request: T; response: R }[];
	failed: { request: T; error: string }[];
}

class MsGraphBatchProcessor {
	private readonly logger = createLogger({
		level: 'info',
		format: format.combine(format.timestamp(), format.json()),
		transports: [new transports.Console()],
	});

	constructor(
		private readonly client: Client,
		private readonly options: {
			batchSize: number; // Max items per batch (default: 20)
			concurrency: number; // Concurrent requests (default: 2)
			maxRetries: number; // Max retry attempts (default: 3)
			retryDelay: number; // Base delay between retries in ms (default: 1000)
			queueInterval: number; // Interval between queue processing in ms (default: 1000)
		} = {
			batchSize: 20,
			concurrency: 2,
			maxRetries: 3,
			retryDelay: options.retryDelay ?? 0 / 1000 ?? 30,
			queueInterval: 1000,
		}
	) {
		this.options = {
			...options,
		};
	}

	/**
	 * Process a large number of requests in batches
	 * @param requests Array of request items to be processed
	 * @param requestBuilder Function to transform items into batch requests
	 * @returns BatchResult containing successful and failed items
	 */
	async processBatch<T, R>(
		requests: T[],
		requestBuilder: (item: T) => Omit<BatchRequest<any>, 'id'>
	): Promise<BatchResult<T, R>> {
		const results: BatchResult<T, R> = {
			successful: [],
			failed: [],
		};

		// Split requests into chunks of batchSize
		const batches = this.chunkArray(requests, this.options.batchSize);

		// Create a queue with limited concurrency
		const queue = new PQueue({
			concurrency: this.options.concurrency,
			autoStart: true,
			interval: this.options.queueInterval,
		});

		// Process each batch
		for (const batch of batches) {
			await queue.add(async () => {
				const batchResult = await this.processSingleBatchWithRetry<T, R>(
					batch,
					requestBuilder
				);

				results.successful.push(...batchResult.successful);
				results.failed.push(...batchResult.failed);
			});
		}

		// Wait for all batches to complete
		await queue.onIdle();

		// Log summary
		this.logger.info(
			`Batch processing completed. Success: ${results.successful.length}, Failed: ${results.failed.length}`
		);

		return results;
	}
	private async processSingleBatchWithRetry<T, R>(
		items: T[],
		requestBuilder: (item: T) => Omit<BatchRequest<any>, 'id'>,
		attempt = 1
	): Promise<BatchResult<T, R>> {
		const batchRequests = items.map((item) => ({
			id: uuid4(),
			...requestBuilder(item),
		}));

		try {
			const response = await this.client.api('/$batch').post({
				requests: batchRequests,
			});

			return this.processBatchResponse(response.responses, items);
		} catch (error: unknown) {
			const graphError = error as GraphError;

			if (
				graphError['statusCode'] === 429 &&
				attempt < this.options.maxRetries
			) {
				const retryAfter = Number(
					(Number(
						graphError.headers?.get('Retry-After')
					) as unknown as number) || this.options.retryDelay
				);

				this.logger.warn(
					`Rate limited. Retrying after ${retryAfter}s. Attempt ${attempt}`
				);

				// Await the retry delay
				await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));

				// Retry the batch processing
				return this.processSingleBatchWithRetry(
					items,
					requestBuilder,
					attempt + 1
				);
			}

			// If max retries reached or another error, mark all items as failed
			this.logger.error(`Batch request failed: ${graphError}`);
			return {
				successful: [],
				failed: items.map((item) => ({
					request: item,
					error: `Batch request failed: ${graphError}`,
				})),
			};
		}
	}
	private processBatchResponse<T, R>(
		responses: BatchResponse<R>[],
		originalItems: T[]
	): BatchResult<T, R> {
		const results: BatchResult<T, R> = {
			successful: [],
			failed: [],
		};

		responses.forEach((response, index) => {
			if (response.status >= 200 && response.status < 300 && response.body) {
				results.successful.push({
					request: originalItems[index],
					response: response.body,
				});
			} else {
				this.logger.warn(`Failed Response: ${JSON.stringify(response)} `);
				results.failed.push({
					request: originalItems[index],
					error:
						response.body?.error?.message ||
						`Unknown error (Status: ${response.status})`,
				});
			}
		});

		return results;
	}

	private chunkArray<T>(array: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size));
		}
		return chunks;
	}
}

export { MsGraphBatchProcessor, BatchRequest, BatchResponse, BatchResult };
