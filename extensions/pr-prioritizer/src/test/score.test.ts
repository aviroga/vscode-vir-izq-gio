/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';

import { scorePRs, computeBreakdown, WEIGHTS } from '../core/score';
import type { NormalizedPR } from '../core/types';
import type { Signals } from '../core/signals';

// __dirname here is extensions/pr-prioritizer/out/test/ after compilation
const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', '..', '..', 'pr-prioritizer', 'fixtures', 'sample-prs.json');

function loadFixture(): { prs: NormalizedPR[] } {
	return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

const REF_DATE = new Date('2026-01-15T12:00:00.000Z');

function makeSignals(overrides: Partial<Signals> = {}): Signals {
	return {
		ageDays: 0,
		size: 0,
		sizeBucket: 'XS',
		linkedIssues: [],
		hasTests: false,
		isBlocked: false,
		isExternal: true,
		isDraft: false,
		labels: [],
		milestone: null,
		...overrides,
	};
}

describe('computeBreakdown', () => {
	test('only age=0 and size=WEIGHTS.size when ageDays=0 and size=0', () => {
		const bd = computeBreakdown(makeSignals({ ageDays: 0, size: 0 }));
		assert.equal(bd.age, 0);
		assert.equal(bd.size, WEIGHTS.size);
		assert.equal(bd.issue, 0);
		assert.equal(bd.tests, 0);
		assert.equal(bd.milestone, 0);
		assert.equal(bd.labels, 0);
		assert.equal(bd.total, WEIGHTS.size);
	});

	test('age caps at WEIGHTS.age when ageDays >= 90', () => {
		const bd = computeBreakdown(makeSignals({ ageDays: 90 }));
		assert.equal(bd.age, WEIGHTS.age);

		const bd2 = computeBreakdown(makeSignals({ ageDays: 200 }));
		assert.equal(bd2.age, WEIGHTS.age);
	});

	test('age is proportional for less than 90 days', () => {
		const bd = computeBreakdown(makeSignals({ ageDays: 45 }));
		const expected = parseFloat(((45 / 90) * WEIGHTS.age).toFixed(2));
		assert.equal(bd.age, expected);
	});

	test('size gives full WEIGHTS.size for 0 lines changed', () => {
		const bd = computeBreakdown(makeSignals({ size: 0 }));
		assert.equal(bd.size, WEIGHTS.size);
	});

	test('size gives 0 for >= 1000 lines changed', () => {
		const bd = computeBreakdown(makeSignals({ size: 1000 }));
		assert.equal(bd.size, 0);

		const bd2 = computeBreakdown(makeSignals({ size: 5000 }));
		assert.equal(bd2.size, 0);
	});

	test('issue bonus applied when at least one issue linked', () => {
		const bd = computeBreakdown(makeSignals({ linkedIssues: [42] }));
		assert.equal(bd.issue, WEIGHTS.issue);
	});

	test('no issue bonus when no issues linked', () => {
		const bd = computeBreakdown(makeSignals({ linkedIssues: [] }));
		assert.equal(bd.issue, 0);
	});

	test('tests bonus applied when hasTests=true', () => {
		const bd = computeBreakdown(makeSignals({ hasTests: true }));
		assert.equal(bd.tests, WEIGHTS.tests);
	});

	test('milestone bonus applied when milestone is set', () => {
		const bd = computeBreakdown(makeSignals({ milestone: 'November 2025' }));
		assert.equal(bd.milestone, WEIGHTS.milestone);
	});

	test('labels bonus applied when at least one label present', () => {
		const bd = computeBreakdown(makeSignals({ labels: ['bug'] }));
		assert.equal(bd.labels, WEIGHTS.labels);
	});

	test('total equals sum of parts', () => {
		const signals = makeSignals({
			ageDays: 90,
			size: 0,
			linkedIssues: [1],
			hasTests: true,
			milestone: 'v1',
			labels: ['bug'],
		});
		const bd = computeBreakdown(signals);
		const expected = parseFloat((WEIGHTS.age + WEIGHTS.size + WEIGHTS.issue + WEIGHTS.tests + WEIGHTS.milestone + WEIGHTS.labels).toFixed(2));
		assert.equal(bd.total, expected);
	});
});

describe('scorePRs — hard filters', () => {
	test('draft PRs go to filtered, not ranked', () => {
		const { prs } = loadFixture();
		const { ranked, filtered } = scorePRs(prs, WEIGHTS, REF_DATE);

		const rankedNumbers = ranked.map(r => r.pr.number);
		const filteredNumbers = filtered.map(f => f.pr.number);

		assert.ok(!rankedNumbers.includes(102));
		assert.ok(filteredNumbers.includes(102));
	});

	test('draft filter reason is "Draft"', () => {
		const { prs } = loadFixture();
		const { filtered } = scorePRs(prs, WEIGHTS, REF_DATE);
		const draft = filtered.find(f => f.pr.number === 102);
		assert.ok(draft);
		assert.equal(draft.reason, 'Draft');
	});

	test('CHANGES_REQUESTED PR goes to filtered', () => {
		const { prs } = loadFixture();
		const { filtered } = scorePRs(prs, WEIGHTS, REF_DATE);
		assert.ok(filtered.some(f => f.pr.number === 105));
	});

	test('dirty mergeable_state PR goes to filtered', () => {
		const { prs } = loadFixture();
		const { filtered } = scorePRs(prs, WEIGHTS, REF_DATE);
		assert.ok(filtered.some(f => f.pr.number === 103));
	});

	test('conflicting mergeable_state PR goes to filtered', () => {
		const { prs } = loadFixture();
		const { filtered } = scorePRs(prs, WEIGHTS, REF_DATE);
		assert.ok(filtered.some(f => f.pr.number === 108));
	});

	test('internal PRs go to internal list, not ranked or filtered', () => {
		const { prs } = loadFixture();
		const { ranked, filtered, internal } = scorePRs(prs, WEIGHTS, REF_DATE);

		assert.ok(internal.some(p => p.number === 104));
		assert.ok(!ranked.some(r => r.pr.number === 104));
		assert.ok(!filtered.some(f => f.pr.number === 104));
	});
});

describe('scorePRs — ranking order', () => {
	test('ranked list is sorted descending by score', () => {
		const { prs } = loadFixture();
		const { ranked } = scorePRs(prs, WEIGHTS, REF_DATE);

		for (let i = 1; i < ranked.length; i++) {
			assert.ok(
				ranked[i - 1].breakdown.total >= ranked[i].breakdown.total,
				`PR at rank ${i - 1} (score ${ranked[i - 1].breakdown.total}) should be >= rank ${i} (score ${ranked[i].breakdown.total})`,
			);
		}
	});

	test('PR with more signals ranks above PR with fewer signals', () => {
		const { prs } = loadFixture();
		const { ranked } = scorePRs(prs, WEIGHTS, REF_DATE);

		const rank100 = ranked.findIndex(r => r.pr.number === 100);
		const rank107 = ranked.findIndex(r => r.pr.number === 107);

		assert.ok(rank100 < rank107, `PR #100 (rank ${rank100}) should beat #107 (rank ${rank107})`);
	});

	test('total number of ranked PRs matches non-draft, non-blocked, external PRs', () => {
		const { prs } = loadFixture();
		const { ranked } = scorePRs(prs, WEIGHTS, REF_DATE);
		assert.equal(ranked.length, 5);
	});
});

describe('WEIGHTS', () => {
	test('WEIGHTS keys are the expected set', () => {
		const keys = Object.keys(WEIGHTS).sort();
		assert.deepEqual(keys, ['age', 'issue', 'labels', 'milestone', 'size', 'tests']);
	});

	test('all WEIGHTS values are positive numbers', () => {
		for (const [key, value] of Object.entries(WEIGHTS)) {
			assert.ok(typeof value === 'number' && value > 0, `WEIGHTS.${key} should be a positive number`);
		}
	});

	test('WEIGHTS sum to approximately 100', () => {
		const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
		assert.equal(total, 100);
	});
});
