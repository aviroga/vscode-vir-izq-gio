/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { GitExtension } from './typings/git';

function parseGitHubRemoteUrl(url: string): { owner: string; repo: string } | undefined {
	const match =
		/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/i.exec(url) ||
		/^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/i.exec(url);
	return match ? { owner: match[1], repo: match[2] } : undefined;
}

export async function detectRepo(): Promise<{ owner: string; repo: string }> {
	const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');

	if (gitExt) {
		const api = gitExt.isActive ? gitExt.exports.getAPI(1) : (await gitExt.activate()).getAPI(1);

		for (const repository of api.repositories) {
			for (const remote of repository.state.remotes) {
				const url = remote.fetchUrl ?? remote.pushUrl;
				if (url) {
					const parsed = parseGitHubRemoteUrl(url);
					if (parsed) {
						return parsed;
					}
				}
			}
		}
	}

	// Fallback: manual input
	const input = await vscode.window.showInputBox({
		prompt: 'Enter the GitHub repository (owner/repo)',
		placeHolder: 'e.g. microsoft/vscode',
		validateInput: value => {
			if (!value || !/^[^/]+\/[^/]+$/.test(value.trim())) {
				return 'Must be in owner/repo format';
			}
			return undefined;
		},
	});

	if (!input) {
		throw new Error('No repository provided.');
	}

	const [owner, repo] = input.trim().split('/');
	return { owner, repo };
}
