/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('prPrioritizer.generateReport', () => {
			vscode.window.showInformationMessage('PR Prioritizer: not implemented yet');
		})
	);
}

export function deactivate(): void { }
