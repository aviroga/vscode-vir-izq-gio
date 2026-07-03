/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';
import { createClient } from './core/github';

const GITHUB_SCOPES = ['repo'];

let _octokit: Promise<Octokit> | undefined;

export function getOctokit(): Promise<Octokit> {
	if (!_octokit) {
		_octokit = Promise.resolve(
			vscode.authentication.getSession('github', GITHUB_SCOPES, { createIfNone: true })
		).then(session => createClient(session.accessToken))
			.then(undefined, err => {
				_octokit = undefined;
				throw err;
			});
	}

	return _octokit;
}

export function resetOctokitCache(): void {
	_octokit = undefined;
}
