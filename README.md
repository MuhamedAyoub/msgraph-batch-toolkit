# MS Graph Batch Processor

A utility library for batch processing Microsoft Graph API requests with built-in retry logic, rate limiting, and logging.

## Installation

```bash
pnpm install
```

## Usage

```typescript
import { Client } from '@microsoft/microsoft-graph-client';

const client = Client.init({
	// your graph client config
});

const processor = new MsGraphBatchProcessor(client, {
	batchSize: 20,
	concurrency: 2,
});

const requests = [
	// your requests
];

const results = await processor.processBatch(requests, (item) => ({
	method: 'GET',
	url: `/users/${item.id}`,
}));
```

## License

MIT
