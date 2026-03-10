import { Index, MeiliSearch, SearchParams } from 'meilisearch';
import { config } from '../config';
import type {
	SearchQuery,
	SearchResult,
	EmailDocument,
	TopSender,
	User,
} from '@open-archiver/types';
import { FilterBuilder } from './FilterBuilder';
import { AuditService } from './AuditService';

const ALLOWED_FILTER_ATTRIBUTES = new Set([
	'from',
	'to',
	'cc',
	'bcc',
	'timestamp',
	'ingestionSourceId',
	'userEmail',
]);

/**
 * Sanitizes a Meilisearch filter string by verifying that every attribute
 * referenced in the expression belongs to the known set of filterable fields.
 * Returns the filter unchanged when it is safe, or undefined when it contains
 * an unknown attribute (to prevent filter injection).
 */
function sanitizeFilter(filter: string): string | undefined {
	// Match every identifier that is followed by a comparison operator or IN/NOT IN keyword.
	const attrRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|!=|>=|<=|>|<|\bIN\b|\bNOT\s+IN\b)/gi;
	let match: RegExpExecArray | null;
	while ((match = attrRegex.exec(filter)) !== null) {
		if (!ALLOWED_FILTER_ATTRIBUTES.has(match[1])) {
			return undefined;
		}
	}
	return filter;
}

export class SearchService {
	private client: MeiliSearch;
	private auditService: AuditService;

	constructor() {
		this.client = new MeiliSearch({
			host: config.search.host,
			apiKey: config.search.apiKey,
		});
		this.auditService = new AuditService();
	}

	public async getIndex<T extends Record<string, any>>(name: string): Promise<Index<T>> {
		return this.client.index<T>(name);
	}

	public async addDocuments<T extends Record<string, any>>(
		indexName: string,
		documents: T[],
		primaryKey?: string
	) {
		const index = await this.getIndex<T>(indexName);
		if (primaryKey) {
			index.update({ primaryKey });
		}
		return index.addDocuments(documents);
	}

	public async search<T extends Record<string, any>>(
		indexName: string,
		query: string,
		options?: any
	) {
		const index = await this.getIndex<T>(indexName);
		return index.search(query, options);
	}

	public async deleteDocuments(indexName: string, ids: string[]) {
		const index = await this.getIndex(indexName);
		return index.deleteDocuments(ids);
	}

	public async deleteDocumentsByFilter(indexName: string, filter: string | string[]) {
		const index = await this.getIndex(indexName);
		return index.deleteDocuments({ filter });
	}

	public async searchEmails(
		dto: SearchQuery,
		userId: string,
		actorIp: string
	): Promise<SearchResult> {
		const { query, filters, filter, page = 1, limit = 10, matchingStrategy = 'last' } = dto;
		const index = await this.getIndex<EmailDocument>('emails');

		const searchParams: SearchParams = {
			limit,
			offset: (page - 1) * limit,
			attributesToHighlight: ['*'],
			showMatchesPosition: true,
			sort: ['timestamp:desc'],
			matchingStrategy,
		};

		if (filters) {
			const filterStrings = Object.entries(filters).map(([key, value]) => {
				if (typeof value === 'string') {
					return `${key} = '${value}'`;
				}
				return `${key} = ${value}`;
			});
			searchParams.filter = filterStrings.join(' AND ');
		}

		// Apply the sanitized user-provided filter expression if present.
		if (filter) {
			const safeFilter = sanitizeFilter(filter);
			if (safeFilter) {
				if (searchParams.filter) {
					searchParams.filter = `${searchParams.filter} AND ${safeFilter}`;
				} else {
					searchParams.filter = safeFilter;
				}
			}
		}

		// Create a filter based on the user's permissions.
		// This ensures that the user can only search for emails they are allowed to see.
		const { searchFilter } = await FilterBuilder.create(userId, 'archive', 'read');
		if (searchFilter) {
			// Convert the MongoDB-style filter from CASL to a MeiliSearch filter string.
			if (searchParams.filter) {
				// If there are existing filters, append the access control filter.
				searchParams.filter = `${searchParams.filter} AND ${searchFilter}`;
			} else {
				// Otherwise, just use the access control filter.
				searchParams.filter = searchFilter;
			}
		}
		// console.log('searchParams', searchParams);
		const searchResults = await index.search(query, searchParams);

		await this.auditService.createAuditLog({
			actorIdentifier: userId,
			actionType: 'SEARCH',
			targetType: 'ArchivedEmail',
			targetId: '',
			actorIp,
			details: {
				query,
				filters,
				filter,
				page,
				limit,
				matchingStrategy,
			},
		});

		return {
			hits: searchResults.hits,
			total: searchResults.estimatedTotalHits ?? searchResults.hits.length,
			page,
			limit,
			totalPages: Math.ceil(
				(searchResults.estimatedTotalHits ?? searchResults.hits.length) / limit
			),
			processingTimeMs: searchResults.processingTimeMs,
		};
	}

	public async getTopSenders(limit = 10): Promise<TopSender[]> {
		const index = await this.getIndex<EmailDocument>('emails');
		const searchResults = await index.search('', {
			facets: ['from'],
			limit: 0,
		});

		if (!searchResults.facetDistribution?.from) {
			return [];
		}

		// Sort and take top N
		const sortedSenders = Object.entries(searchResults.facetDistribution.from)
			.sort(([, countA], [, countB]) => countB - countA)
			.slice(0, limit)
			.map(([sender, count]) => ({ sender, count }));

		return sortedSenders;
	}

	public async configureEmailIndex() {
		const index = await this.getIndex('emails');
		await index.updateSettings({
			searchableAttributes: [
				'subject',
				'body',
				'from',
				'to',
				'cc',
				'bcc',
				'attachments.filename',
				'attachments.content',
				'userEmail',
			],
			filterableAttributes: [
				'from',
				'to',
				'cc',
				'bcc',
				'timestamp',
				'ingestionSourceId',
				'userEmail',
			],
			sortableAttributes: ['timestamp'],
		});
	}
}
