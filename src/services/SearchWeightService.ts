import type { SearchWeights } from "../settings";
import type { MetadataRepository } from "../database/repositories/MetadataRepository";
import type { NoteRepository } from "../database/repositories/NoteRepository";

export interface WeightedSearchResult {
	noteId: string;
	title: string;
	filePath: string;
	baseScore: number;
	weightedScore: number;
	snippet: string;
	backlinkCount: number;
	tagMatchCount: number;
	// For debugging/display
	weights?: {
		titleBonus: number;
		backlinkBonus: number;
		tagBonus: number;
	};
}

interface SearchResultInput {
	noteId: string;
	title: string;
	filePath: string;
	score: number;
	snippet: string;
}

export class SearchWeightService {
	constructor(
		private noteRepo: NoteRepository,
		private metadataRepo: MetadataRepository,
		private getWeights: () => SearchWeights
	) {}

	/**
	 * Apply search weights to a list of search results.
	 * @param results The raw search results
	 * @param query The search query (used for tag matching)
	 * @returns Weighted and re-sorted results
	 */
	applyWeights(
		results: SearchResultInput[],
		query: string
	): WeightedSearchResult[] {
		if (results.length === 0) return [];

		const weights = this.getWeights();
		const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

		// Batch fetch backlink counts for all result notes
		const noteIds = results.map((r) => r.noteId);
		const backlinkCounts = this.metadataRepo.getBacklinkCounts(noteIds);

		const weightedResults: WeightedSearchResult[] = results.map((result) => {
			const backlinkCount = backlinkCounts.get(result.noteId) || 0;

			// Tag matching: check if query terms match any tags
			const noteTags = this.metadataRepo.getTagsForNote(result.noteId);
			const tagMatchCount = this.countTagMatches(noteTags, queryTerms);

			// Title matching bonus: check if query appears in title
			const titleLower = result.title.toLowerCase();
			const isTitleMatch = queryTerms.some((term) => titleLower.includes(term));
			const titleBonus = isTitleMatch ? weights.title : 1.0;

			// Backlink bonus
			const backlinkBonus = backlinkCount * weights.backlink;

			// Tag match bonus
			const tagBonus = tagMatchCount * weights.tag;

			// Calculate weighted score
			// Formula: baseScore × titleWeight + backlinkBonus + tagBonus
			const weightedScore = result.score * titleBonus + backlinkBonus + tagBonus;

			return {
				noteId: result.noteId,
				title: result.title,
				filePath: result.filePath,
				baseScore: result.score,
				weightedScore,
				snippet: result.snippet,
				backlinkCount,
				tagMatchCount,
				weights: {
					titleBonus,
					backlinkBonus,
					tagBonus,
				},
			};
		});

		// Sort by weighted score (descending)
		weightedResults.sort((a, b) => b.weightedScore - a.weightedScore);

		return weightedResults;
	}

	/**
	 * Count how many query terms match note tags.
	 */
	private countTagMatches(noteTags: string[], queryTerms: string[]): number {
		if (noteTags.length === 0 || queryTerms.length === 0) return 0;

		const tagsLower = noteTags.map((t) => t.toLowerCase());
		let matches = 0;

		for (const term of queryTerms) {
			if (tagsLower.some((tag) => tag.includes(term) || term.includes(tag))) {
				matches++;
			}
		}

		return matches;
	}

	/**
	 * Normalize scores to 0-1 range after weighting.
	 * Useful for displaying as percentage.
	 */
	normalizeScores(results: WeightedSearchResult[]): WeightedSearchResult[] {
		if (results.length === 0) return [];

		const maxScore = Math.max(...results.map((r) => r.weightedScore));
		if (maxScore === 0) return results;

		return results.map((r) => ({
			...r,
			weightedScore: r.weightedScore / maxScore,
		}));
	}
}
