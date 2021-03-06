/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// <amd-dependency path="vs/css!./folding" />

'use strict';

import * as nls from 'vs/nls';
import * as types from 'vs/base/common/types';
import * as dom from 'vs/base/browser/dom';
import { RunOnceScheduler, Delayer } from 'vs/base/common/async';
import { KeyCode, KeyMod, KeyChord } from 'vs/base/common/keyCodes';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { TPromise } from 'vs/base/common/winjs.base';
import { ICommonCodeEditor, ScrollType } from 'vs/editor/common/editorCommon';
import { editorAction, ServicesAccessor, EditorAction, CommonEditorRegistry } from 'vs/editor/common/editorCommonExtensions';
import { ICodeEditor, IEditorMouseEvent, MouseTargetType } from 'vs/editor/browser/editorBrowser';
import { editorContribution } from 'vs/editor/browser/editorBrowserExtensions';
import { FoldingModel, FoldingRegion, setCollapseStateAtLevel, setCollapseStateRecursivly, fold, unfold } from 'vs/editor/contrib/folding/common/foldingModel';
import { computeRanges, limitByIndent } from 'vs/editor/contrib/folding/common/indentFoldStrategy';
import { FoldingDecorationProvider } from './foldingDecorations';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { IConfigurationChangedEvent } from 'vs/editor/common/config/editorOptions';
import { IMarginData } from 'vs/editor/browser/controller/mouseTarget';
import { HiddenRangeModel } from 'vs/editor/contrib/folding/common/hiddenRangeModel';
import { IRange } from 'vs/editor/common/core/range';

export const ID = 'editor.contrib.folding';

@editorContribution
export class FoldingController {

	static MAX_FOLDING_REGIONS = 5000;


	public static get(editor: ICommonCodeEditor): FoldingController {
		return editor.getContribution<FoldingController>(ID);
	}

	private editor: ICodeEditor;
	private _isEnabled: boolean;
	private _autoHideFoldingControls: boolean;

	private foldingDecorationProvider: FoldingDecorationProvider;

	private foldingModel: FoldingModel;
	private hiddenRangeModel: HiddenRangeModel;

	private foldingModelPromise: TPromise<FoldingModel>;
	private updateScheduler: Delayer<FoldingModel>;

	private globalToDispose: IDisposable[];

	private cursorChangedScheduler: RunOnceScheduler;

	private localToDispose: IDisposable[];

	constructor(editor: ICodeEditor) {
		this.editor = editor;
		this._isEnabled = this.editor.getConfiguration().contribInfo.folding;
		this._autoHideFoldingControls = this.editor.getConfiguration().contribInfo.showFoldingControls === 'mouseover';

		this.globalToDispose = [];
		this.localToDispose = [];

		this.foldingDecorationProvider = new FoldingDecorationProvider();
		this.foldingDecorationProvider.autoHideFoldingControls = this._autoHideFoldingControls;

		this.globalToDispose.push(this.editor.onDidChangeModel(() => this.onModelChanged()));

		this.globalToDispose.push(this.editor.onDidChangeConfiguration((e: IConfigurationChangedEvent) => {
			if (e.contribInfo) {
				let oldIsEnabled = this._isEnabled;
				this._isEnabled = this.editor.getConfiguration().contribInfo.folding;
				if (oldIsEnabled !== this._isEnabled) {
					this.onModelChanged();
				}
				let oldShowFoldingControls = this._autoHideFoldingControls;
				this._autoHideFoldingControls = this.editor.getConfiguration().contribInfo.showFoldingControls === 'mouseover';
				if (oldShowFoldingControls !== this._autoHideFoldingControls) {
					this.foldingDecorationProvider.autoHideFoldingControls = this._autoHideFoldingControls;
					this.onModelContentChanged();
				}
			}
		}));
		this.globalToDispose.push({ dispose: () => dispose(this.localToDispose) });
		this.onModelChanged();
	}

	public getId(): string {
		return ID;
	}

	public dispose(): void {
		this.globalToDispose = dispose(this.globalToDispose);
	}

	/**
	 * Store view state.
	 */
	public saveViewState(): any {
		let model = this.editor.getModel();
		if (!model) {
			return {};
		}
		let collapsedIndexes: number[] = [];
		for (let region of this.foldingModel.regions) {
			if (region.isCollapsed && region.editorDecorationId) {
				var range = model.getDecorationRange(region.editorDecorationId);
				if (range) {
					collapsedIndexes.push(range.startLineNumber);
				}
			}
		}
		return { collapsedIndexes, lineCount: model.getLineCount() };
	}

	/**
	 * Restore view state.
	 */
	public restoreViewState(state: any): void {
		let model = this.editor.getModel();
		if (!model) {
			return;
		}
		if (!this._isEnabled) {
			return;
		}
		if (!state || !Array.isArray(state.collapsedIndexes) || state.collapsedIndexes.length === 0 || state.lineCount !== model.getLineCount()) {
			return;
		}
		this.getFoldingModel().then(foldingModel => {
			let toToogle: FoldingRegion[] = [];
			for (let index of state.collapsedIndexes) {
				let region = foldingModel.getRegionAtLine(index);
				if (region && !region.isCollapsed) {
					toToogle.push(region);
				}
			}
			foldingModel.toggleCollapseState(toToogle);
		});
	}

	private onModelChanged(): void {
		this.localToDispose = dispose(this.localToDispose);

		let model = this.editor.getModel();
		if (!this._isEnabled || !model) {
			return;
		}

		this.foldingModel = new FoldingModel(model, this.foldingDecorationProvider);
		this.localToDispose.push(this.foldingModel);

		this.hiddenRangeModel = new HiddenRangeModel(this.foldingModel);
		this.localToDispose.push(this.hiddenRangeModel);
		this.localToDispose.push(this.hiddenRangeModel.onDidChange(hr => this.onHiddenRangesChanges(hr)));

		this.updateScheduler = new Delayer<FoldingModel>(200);
		this.localToDispose.push({ dispose: () => this.updateScheduler.cancel() });

		this.cursorChangedScheduler = new RunOnceScheduler(() => this.revealCursor(), 200);
		this.localToDispose.push(this.cursorChangedScheduler);
		this.localToDispose.push(this.editor.onDidChangeModelLanguageConfiguration(e => this.onModelContentChanged())); // also covers model language changes
		this.localToDispose.push(this.editor.onDidChangeModelContent(e => this.onModelContentChanged()));
		this.localToDispose.push(this.editor.onDidChangeCursorPosition(e => this.onCursorPositionChanged()));
		this.localToDispose.push(this.editor.onMouseDown(e => this.onEditorMouseDown(e)));
		this.localToDispose.push(this.editor.onMouseUp(e => this.onEditorMouseUp(e)));

		this.onModelContentChanged();
	}

	private computeRanges() {
		let editorModel = this.editor.getModel();
		if (editorModel) {
			let ranges = computeRanges(editorModel);
			ranges = limitByIndent(ranges, FoldingController.MAX_FOLDING_REGIONS).sort((r1, r2) => r1.startLineNumber - r2.startLineNumber);
			return ranges;
		}

		return [];
	}

	public getFoldingModel() {
		return this.foldingModelPromise;
	}

	private onModelContentChanged() {
		this.foldingModelPromise = this.updateScheduler.trigger(() => {
			this.foldingModel.update(this.computeRanges());
			return this.foldingModel;
		});
	}

	private onHiddenRangesChanges(hiddenRanges: IRange[]) {
		let selections = this.editor.getSelections();
		if (this.hiddenRangeModel.adjustSelections(selections)) {
			this.editor.setSelections(selections);
		}
		this.editor.setHiddenAreas(hiddenRanges);
	}

	private onCursorPositionChanged() {
		if (this.hiddenRangeModel.hasRanges()) {
			this.cursorChangedScheduler.schedule();
		}
	}

	private revealCursor() {
		this.getFoldingModel().then(foldingModel => {
			let selections = this.editor.getSelections();
			for (let selection of selections) {
				let lineNumber = selection.selectionStartLineNumber;
				if (this.hiddenRangeModel.isHidden(lineNumber)) {
					let toToggle = foldingModel.getAllRegionsAtLine(lineNumber, r => r.isCollapsed && lineNumber > r.range.startLineNumber);
					foldingModel.toggleCollapseState(toToggle);
				}
			}
		});
	}

	private mouseDownInfo: { lineNumber: number, iconClicked: boolean };

	private onEditorMouseDown(e: IEditorMouseEvent): void {
		this.mouseDownInfo = null;

		let range = e.target.range;
		if (!range) {
			return;
		}
		if (!e.event.leftButton) {
			return;
		}
		let iconClicked = false;
		switch (e.target.type) {
			case MouseTargetType.GUTTER_LINE_DECORATIONS:
				const data = e.target.detail as IMarginData;
				const gutterOffsetX = data.offsetX - data.glyphMarginWidth - data.lineNumbersWidth;

				// TODO@joao TODO@alex TODO@martin this is such that we don't collide with dirty diff
				if (gutterOffsetX <= 12) {
					return;
				}

				iconClicked = true;
				break;
			case MouseTargetType.CONTENT_EMPTY: {
				let model = this.editor.getModel();
				if (range.startColumn === model.getLineMaxColumn(range.startLineNumber)) {
					let editorCoords = dom.getDomNodePagePosition(this.editor.getDomNode());
					let pos = this.editor.getScrolledVisiblePosition(range.getEndPosition());
					if (e.event.posy > editorCoords.top + pos.top + pos.height) {
						return;
					}
					break;
				}
				return;
			}
			case MouseTargetType.CONTENT_TEXT: {
				let model = this.editor.getModel();
				if (range.startColumn === model.getLineMaxColumn(range.startLineNumber)) {
					break;
				}
				return;
			}
			default:
				return;
		}

		this.mouseDownInfo = { lineNumber: range.startLineNumber, iconClicked };
	}

	private onEditorMouseUp(e: IEditorMouseEvent): void {
		if (!this.mouseDownInfo) {
			return;
		}
		let lineNumber = this.mouseDownInfo.lineNumber;
		let iconClicked = this.mouseDownInfo.iconClicked;

		let range = e.target.range;
		if (!range || range.startLineNumber !== lineNumber) {
			return;
		}

		if (iconClicked) {
			if (e.target.type !== MouseTargetType.GUTTER_LINE_DECORATIONS) {
				return;
			}
		} else {
			let model = this.editor.getModel();
			if (range.startColumn !== model.getLineMaxColumn(lineNumber)) {
				return;
			}
		}

		this.getFoldingModel().then(foldingModel => {
			let region = foldingModel.getRegionAtLine(lineNumber);
			if (region) {
				if (iconClicked || region.isCollapsed) {
					foldingModel.toggleCollapseState([region]);
					this.reveal(lineNumber);
				}
				return;
			}
		});
	}

	public reveal(focusLine: number): void {
		this.editor.revealPositionInCenterIfOutsideViewport({ lineNumber: focusLine, column: 1 }, ScrollType.Smooth);
	}
}

abstract class FoldingAction<T> extends EditorAction {

	abstract invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor, args: T): void;

	public runEditorCommand(accessor: ServicesAccessor, editor: ICommonCodeEditor, args: T): void | TPromise<void> {
		let foldingController = FoldingController.get(editor);
		if (!foldingController) {
			return;
		}
		this.reportTelemetry(accessor, editor);
		return foldingController.getFoldingModel().then(foldingModel => {
			this.invoke(foldingController, foldingModel, editor, args);
		});
	}

	protected getSelectedLines(editor: ICommonCodeEditor) {
		return editor.getSelections().map(s => s.startLineNumber);
	}

	public run(accessor: ServicesAccessor, editor: ICommonCodeEditor): void {
	}
}

interface FoldingArguments {
	levels?: number;
	direction?: 'up' | 'down';
}

function foldingArgumentsConstraint(args: any) {
	if (!types.isUndefined(args)) {
		if (!types.isObject(args)) {
			return false;
		}
		const foldingArgs: FoldingArguments = args;
		if (!types.isUndefined(foldingArgs.levels) && !types.isNumber(foldingArgs.levels)) {
			return false;
		}
		if (!types.isUndefined(foldingArgs.direction) && !types.isString(foldingArgs.direction)) {
			return false;
		}
	}
	return true;
}

@editorAction
class UnfoldAction extends FoldingAction<FoldingArguments> {

	constructor() {
		super({
			id: 'editor.unfold',
			label: nls.localize('unfoldAction.label', "Unfold"),
			alias: 'Unfold',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.US_CLOSE_SQUARE_BRACKET,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.US_CLOSE_SQUARE_BRACKET
				}
			},
			description: {
				description: 'Unfold the content in the editor',
				args: [
					{
						name: 'Unfold editor argument',
						description: `Property-value pairs that can be passed through this argument:
							* 'level': Number of levels to unfold
						`,
						constraint: foldingArgumentsConstraint
					}
				]
			}
		});
	}

	invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor, args: FoldingArguments): void {
		unfold(foldingModel, args ? args.levels || 1 : 1, this.getSelectedLines(editor));
	}
}

@editorAction
class UnFoldRecursivelyAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.unfoldRecursively',
			label: nls.localize('unFoldRecursivelyAction.label', "Unfold Recursively"),
			alias: 'Unfold Recursively',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KEY_K, KeyMod.CtrlCmd | KeyCode.US_CLOSE_SQUARE_BRACKET)
			}
		});
	}

	invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor, args: any): void {
		setCollapseStateRecursivly(foldingModel, false, this.getSelectedLines(editor));
	}
}

@editorAction
class FoldAction extends FoldingAction<FoldingArguments> {

	constructor() {
		super({
			id: 'editor.fold',
			label: nls.localize('foldAction.label', "Fold"),
			alias: 'Fold',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.US_OPEN_SQUARE_BRACKET,
				mac: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.US_OPEN_SQUARE_BRACKET
				}
			},
			description: {
				description: 'Fold the content in the editor',
				args: [
					{
						name: 'Fold editor argument',
						description: `Property-value pairs that can be passed through this argument:
							* 'levels': Number of levels to fold
							* 'up': If 'true', folds given number of levels up otherwise folds down
						`,
						constraint: foldingArgumentsConstraint
					}
				]
			}
		});
	}

	invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor, args: FoldingArguments): void {
		args = args ? args : { levels: 1, direction: 'up' };
		fold(foldingModel, args.levels || 1, args.direction === 'up', this.getSelectedLines(editor));
	}
}

@editorAction
class FoldRecursivelyAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.foldRecursively',
			label: nls.localize('foldRecursivelyAction.label', "Fold Recursively"),
			alias: 'Fold Recursively',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KEY_K, KeyMod.CtrlCmd | KeyCode.US_OPEN_SQUARE_BRACKET)
			}
		});
	}

	invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor): void {
		let selectedLines = this.getSelectedLines(editor);
		setCollapseStateRecursivly(foldingModel, true, selectedLines);
		if (selectedLines.length > 0) {
			foldingController.reveal(selectedLines[0]);
		}

	}
}

@editorAction
class FoldAllAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.foldAll',
			label: nls.localize('foldAllAction.label', "Fold All"),
			alias: 'Fold All',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KEY_K, KeyMod.CtrlCmd | KeyCode.KEY_0)
			}
		});
	}

	invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor): void {
		setCollapseStateRecursivly(foldingModel, true);
	}
}

@editorAction
class UnfoldAllAction extends FoldingAction<void> {

	constructor() {
		super({
			id: 'editor.unfoldAll',
			label: nls.localize('unfoldAllAction.label', "Unfold All"),
			alias: 'Unfold All',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KEY_K, KeyMod.CtrlCmd | KeyCode.KEY_J)
			}
		});
	}

	invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor): void {
		setCollapseStateRecursivly(foldingModel, false);
	}
}

class FoldLevelAction extends FoldingAction<void> {
	private static ID_PREFIX = 'editor.foldLevel';
	public static ID = (level: number) => FoldLevelAction.ID_PREFIX + level;

	private getFoldingLevel() {
		return parseInt(this.id.substr(FoldLevelAction.ID_PREFIX.length));
	}

	invoke(foldingController: FoldingController, foldingModel: FoldingModel, editor: ICommonCodeEditor): void {
		setCollapseStateAtLevel(foldingModel, this.getFoldingLevel(), true, this.getSelectedLines(editor));
	}
}

for (let i = 1; i <= 9; i++) {
	CommonEditorRegistry.registerEditorAction(
		new FoldLevelAction({
			id: FoldLevelAction.ID(i),
			label: nls.localize('foldLevelAction.label', "Fold Level {0}", i),
			alias: `Fold Level ${i}`,
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.textFocus,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KEY_K, KeyMod.CtrlCmd | (KeyCode.KEY_0 + i))
			}
		})
	);
};
