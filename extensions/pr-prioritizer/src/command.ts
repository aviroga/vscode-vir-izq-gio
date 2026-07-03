/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { detectRepo } from './repo';
import { getOctokit } from './auth';
import { listOpenPRs, getPRDetail, getPRReviews, getPRFiles, normalizePR } from './core/github';
import { scorePRs } from './core/score';
import { buildReport } from './core/report';
import type { Snapshot } from './core/types';

export async function generateReport(): Promise<void> {
	let owner: string;
	let repo: string;

	try {
		({ owner, repo } = await detectRepo());
	} catch (err: unknown) {
		vscode.window.showErrorMessage(`PR Prioritizer: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `PR Prioritizer: fetching ${owner}/${repo}…`,
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const config = vscode.workspace.getConfiguration('prPrioritizer');
				const limit: number = config.get('limit', 50);
				const top: number = config.get('top', 25);

				const client = await getOctokit();
				if (token.isCancellationRequested) { return; }

				progress.report({ message: 'listing open PRs…' });
				const rawList = await listOpenPRs(client, owner, repo, limit);
				if (token.isCancellationRequested) { return; }

				const normalized = [];
				for (let i = 0; i < rawList.length; i++) {
					if (token.isCancellationRequested) { return; }
					progress.report({ message: `fetching PR ${i + 1} / ${rawList.length}…` });
					const item = rawList[i];
					const [detail, reviews, files] = await Promise.all([
						getPRDetail(client, owner, repo, item.number),
						getPRReviews(client, owner, repo, item.number),
						getPRFiles(client, owner, repo, item.number),
					]);
					normalized.push(normalizePR(item, detail, reviews, files));
				}

				const snapshot: Snapshot = {
					repo: `${owner}/${repo}`,
					fetched_at: new Date().toISOString(),
					total_open: normalized.length,
					prs: normalized,
				};

				const { ranked, filtered, internal } = scorePRs(snapshot.prs);
				const content = buildReport(snapshot, ranked, filtered, internal, { top });

				const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
				await vscode.window.showTextDocument(doc);
				await vscode.commands.executeCommand('markdown.showPreviewToSide');

			} catch (err: unknown) {
				vscode.window.showErrorMessage(
					`PR Prioritizer: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}
	);
}
