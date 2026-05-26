/**
 * Copyright (c) 2019-2024 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 * @author David Sehnal <david.sehnal@gmail.com>
 * @author Jason Pattle <jpattle.exscientia.co.uk>
 * @author Ludovic Autin <ludovic.autin@gmail.com>
 * @author Ventura Rivera <venturaxrivera@gmail.com>
 */

import * as React from 'react';
import { SymmetryOperator } from '../../mol-math/geometry';
import { Mat4 } from '../../mol-math/linear-algebra';
import { QueryContext, Structure, StructureElement, StructureProperties, StructureSelection } from '../../mol-model/structure';
import { structureAreIntersecting } from '../../mol-model/structure/query/utils/structure-set';
import { alignAndSuperpose } from '../../mol-model/structure/structure/util/superposition';
import { getElementQueries, getNonStandardResidueQueries, getPolymerAndBranchedEntityQueries, StructureSelectionQueries, StructureSelectionQuery } from '../../mol-plugin-state/helpers/structure-selection-query';
import { InteractivityManager } from '../../mol-plugin-state/manager/interactivity';
import { StructureComponentManager } from '../../mol-plugin-state/manager/structure/component';
import { StructureComponentRef, StructureRef } from '../../mol-plugin-state/manager/structure/hierarchy-state';
import { StructureSelectionModifier } from '../../mol-plugin-state/manager/structure/selection';
import { PluginStateObject } from '../../mol-plugin-state/objects';
import { StateTransforms } from '../../mol-plugin-state/transforms';
import { exportCurrentSelection } from '../../extensions/model-export/export';
import { PluginCommands } from '../../mol-plugin/commands';
import { PluginConfig } from '../../mol-plugin/config';
import { PluginContext } from '../../mol-plugin/context';
import { compileIdListSelection } from '../../mol-script/util/id-list';
import { StateObjectCell, StateObjectRef } from '../../mol-state';
import { Color } from '../../mol-util/color';
import { memoizeLatest } from '../../mol-util/memoize';
import { ParamDefinition } from '../../mol-util/param-definition';
import { capitalize, stripTags } from '../../mol-util/string';
import { elementLabel, structureElementStatsLabel } from '../../mol-theme/label';
import { PluginUIComponent, PurePluginUIComponent } from '../base';
import { ActionMenu } from '../controls/action-menu';
import { Button, ControlGroup, IconButton, ToggleButton } from '../controls/common';
import { BrushSvg, CancelOutlinedSvg, CloseSvg, CubeOutlineSvg, GetAppSvg, HelpOutlineSvg, Icon, IntersectSvg, RestoreSvg, SaveOutlinedSvg, SelectionModeSvg, SetSvg, SubtractSvg, SuperposeChainsSvg, UnionSvg, VisibilityOffOutlinedSvg, VisibilityOutlinedSvg } from '../controls/icons';
import { ParameterControls, ParamOnChange, PureSelectControl } from '../controls/parameters';
import { HelpGroup, HelpText, ViewportHelpContent } from '../viewport/help';
import { AddComponentControls } from './components';
import { saveCurrentSelection } from './saved-selection';


export class ToggleSelectionModeButton extends PurePluginUIComponent<{ inline?: boolean }> {
    componentDidMount() {
        this.subscribe(this.plugin.events.canvas3d.settingsUpdated, () => this.forceUpdate());
        this.subscribe(this.plugin.layout.events.updated, () => this.forceUpdate());
        this.subscribe(this.plugin.behaviors.interaction.selectionMode, () => this.forceUpdate());
    }

    _toggleSelMode = () => {
        this.plugin.selectionMode = !this.plugin.selectionMode;
    };

    render() {
        const style = this.props.inline
            ? { background: 'transparent', width: 'auto', height: 'auto', lineHeight: 'unset' }
            : { background: 'transparent' };
        return <IconButton svg={SelectionModeSvg} onClick={this._toggleSelMode} title={'Toggle Selection Mode'} style={style} toggleState={this.plugin.selectionMode} />;
    }
}

const StructureSelectionParams = {
    granularity: InteractivityManager.Params.granularity,
};

type SelectionHelperType = 'residue-list'

interface StructureSelectionActionsControlsState {
    isEmpty: boolean,
    isBusy: boolean,
    canUndo: boolean,

    action?: StructureSelectionModifier | 'theme' | 'add-component' | 'help',
    helper?: SelectionHelperType,
    alignBase?: AlignmentEntry,

    structureSelectionParams?: typeof StructureSelectionParams,
}

interface AlignmentEntry {
    loci: StructureElement.Loci,
    label: string,
    cell: StateObjectCell<PluginStateObject.Molecule.Structure>
}

interface HiddenSelectionTarget {
    structureRef: string,
    componentRef: string,
    selection: Structure
}

const ActionHeader = new Map<StructureSelectionModifier, string>([
    ['add', 'Add/Union Selection'],
    ['remove', 'Remove/Subtract Selection'],
    ['intersect', 'Intersect Selection'],
    ['set', 'Set Selection']
] as const);

export class StructureSelectionActionsControls extends PluginUIComponent<{}, StructureSelectionActionsControlsState> {
    private hiddenSelectionTargets: HiddenSelectionTarget[] = [];

    state = {
        action: void 0 as StructureSelectionActionsControlsState['action'],
        helper: void 0 as StructureSelectionActionsControlsState['helper'],
        alignBase: void 0 as AlignmentEntry | undefined,

        isEmpty: true,
        isBusy: false,
        canUndo: false,

        structureSelectionParams: StructureSelectionParams,
    };

    componentDidMount() {
        this.subscribe(this.plugin.managers.structure.hierarchy.behaviors.selection, c => {
            const isEmpty = c.hierarchy.structures.length === 0;
            if (this.state.isEmpty !== isEmpty) {
                this.setState({ isEmpty });
            }
            // trigger elementQueries and nonStandardResidueQueries recalculation
            this.queriesVersion = -1;
            this.forceUpdate();
        });

        this.subscribe(this.plugin.behaviors.state.isBusy, v => {
            this.setState({ isBusy: v, action: void 0 });
        });

        this.subscribe(this.plugin.managers.interactivity.events.propsUpdated, () => {
            this.forceUpdate();
        });

        this.subscribe(this.plugin.managers.structure.selection.events.changed, () => {
            this.forceUpdate();
        });

        this.subscribe(this.plugin.state.data.events.historyUpdated, ({ state }) => {
            this.setState({ canUndo: state.canUndo });
        });

        // Update structureSelectionParams state if there are custom-defined granularityOptions
        const granularityOptions = this.plugin.spec.components?.selectionTools?.granularityOptions;
        if (granularityOptions) {
            const granularitySet = new Set((granularityOptions));
            const structureSelectionParams = {
                ...StructureSelectionParams,
                granularity: {
                    ...StructureSelectionParams.granularity,
                    options: StructureSelectionParams.granularity.options.filter(([firstItem]) => granularitySet.has(firstItem)),
                },
            };
            this.setState({ structureSelectionParams: structureSelectionParams });
        }
    }

    get isDisabled() {
        return this.state.isBusy || this.state.isEmpty;
    }

    set = (modifier: StructureSelectionModifier, selectionQuery: StructureSelectionQuery) => {
        this.plugin.managers.structure.selection.fromSelectionQuery(modifier, selectionQuery, false);
    };

    selectQuery: ActionMenu.OnSelect = (item, e) => {
        if (!item || !this.state.action) {
            this.setState({ action: void 0 });
            return;
        }
        const q = this.state.action! as StructureSelectionModifier;
        if (e?.shiftKey) {
            this.set(q, item.value as StructureSelectionQuery);
        } else {
            this.setState({ action: void 0 }, () => {
                this.set(q, item.value as StructureSelectionQuery);
            });
        }
    };

    selectHelper: ActionMenu.OnSelect = (item, e) => {
        console.log(item);
        if (!item || !this.state.action) {
            this.setState({ action: void 0, helper: void 0 });
            return;
        }
        this.setState({ helper: (item.value as { kind: SelectionHelperType }).kind });
    };

    get structures() {
        const structures: Structure[] = [];
        for (const s of this.plugin.managers.structure.hierarchy.selection.structures) {
            const structure = s.cell.obj?.data;
            if (structure) structures.push(structure);
        }
        return structures;
    }

    private queriesItems: ActionMenu.Items[] = [];
    private queriesVersion = -1;
    get queries() {
        const { registry } = this.plugin.query.structure;
        if (registry.version !== this.queriesVersion) {
            const structures = this.structures;
            const queries = [
                ...registry.list,
                ...getPolymerAndBranchedEntityQueries(structures),
                ...getNonStandardResidueQueries(structures),
                ...getElementQueries(structures)
            ].sort((a, b) => b.priority - a.priority);
            this.queriesItems = ActionMenu.createItems(queries, {
                filter: q => q !== StructureSelectionQueries.current && !q.isHidden,
                label: q => q.label,
                category: q => q.category,
                description: q => q.description
            });
            this.queriesVersion = registry.version;
        }
        return this.queriesItems;
    }

    private helpersItems?: ActionMenu.Items[] = void 0;
    get helpers() {
        if (this.helpersItems) return this.helpersItems;
        // TODO: this is an initial implementation of the helper UI
        //       the plan is to add support to input queries in different languages
        //       after this has been implemented in mol-script
        const helpers = [
            { kind: 'residue-list' as SelectionHelperType, category: 'Helpers', label: 'Atom/Residue Identifier List', description: 'Create a selection from a list of atom/residue ranges.' }
        ];
        this.helpersItems = ActionMenu.createItems(helpers, {
            label: q => q.label,
            category: q => q.category,
            description: q => q.description
        });
        return this.helpersItems;
    }

    private showAction(q: StructureSelectionActionsControlsState['action']) {
        return () => this.setState({ action: this.state.action === q ? void 0 : q, helper: void 0 });
    }

    toggleAdd = this.showAction('add');
    toggleRemove = this.showAction('remove');
    toggleIntersect = this.showAction('intersect');
    toggleSet = this.showAction('set');
    toggleTheme = this.showAction('theme');
    toggleAddComponent = this.showAction('add-component');
    toggleHelp = this.showAction('help');

    setGranuality: ParamOnChange = ({ value }) => {
        this.plugin.managers.interactivity.setProps({ granularity: value });
    };

    turnOff = () => this.plugin.selectionMode = false;

    undo = () => {
        const task = this.plugin.state.data.undo();
        if (task) this.plugin.runTask(task);
    };

    private getCurrentSelectionTargets() {
        const sel = this.plugin.managers.structure.hierarchy.getStructuresWithSelection();
        const targets: { component: StructureComponentRef, target: HiddenSelectionTarget }[] = [];
        for (const s of sel) {
            const structure = s.cell.obj?.data;
            if (!structure) continue;

            const selection = this.plugin.managers.structure.selection.getStructure(structure);
            if (!selection || selection.elementCount === 0) continue;

            for (const component of s.components) {
                const componentStructure = component.cell.obj?.data;
                if (!componentStructure || !structureAreIntersecting(componentStructure, selection)) continue;
                targets.push({
                    component,
                    target: {
                        structureRef: s.cell.transform.ref,
                        componentRef: component.cell.transform.ref,
                        selection
                    }
                });
            }
        }
        return targets;
    }

    private getHiddenSelectionComponents() {
        const sel = this.plugin.managers.structure.hierarchy.getStructuresWithSelection();
        const components: StructureComponentRef[] = [];
        const seen = new Set<string>();

        for (const s of sel) {
            const structure = s.cell.obj?.data;
            if (!structure) continue;

            const selection = this.plugin.managers.structure.selection.getStructure(structure);
            if (!selection || selection.elementCount === 0) continue;

            for (const target of this.hiddenSelectionTargets) {
                if (target.structureRef !== s.cell.transform.ref) continue;
                if (!structureAreIntersecting(selection, target.selection)) continue;
                if (seen.has(target.componentRef)) continue;

                const component = s.components.find(c => c.cell.transform.ref === target.componentRef);
                if (!component) continue;

                seen.add(target.componentRef);
                components.push(component);
            }
        }

        return components;
    }

    hideSelection = () => {
        const targets = this.getCurrentSelectionTargets();
        const components = targets.map(t => t.component);
        if (components.length === 0) return;
        this.hiddenSelectionTargets.push(...targets.map(t => t.target));
        this.plugin.managers.structure.component.modifyByCurrentSelection(components, 'subtract');
    };

    showSelection = () => {
        const components = this.getHiddenSelectionComponents();
        if (components.length === 0) return;
        this.plugin.managers.structure.component.modifyByCurrentSelection(components, 'union');
    };

    saveSelection = () => {
        saveCurrentSelection(this.plugin);
    };

    exportSelection = () => {
        exportCurrentSelection(this.plugin);
    };

    private getRootStructure(s: Structure) {
        const parent = this.plugin.helpers.substructureParent.get(s)!;
        return this.plugin.state.data.selectQ(q => q.byValue(parent).rootOfType(PluginStateObject.Molecule.Structure))[0].obj?.data!;
    }

    private getCurrentAlignmentEntry(): AlignmentEntry | undefined {
        const location = StructureElement.Location.create();
        const entries: AlignmentEntry[] = [];
        let invalid = false;

        this.plugin.managers.structure.selection.entries.forEach(({ selection }, ref) => {
            if (StructureElement.Loci.isEmpty(selection)) return;
            const cell = StateObjectRef.resolveAndCheck(this.plugin.state.data, ref);
            if (!cell) return;

            const l = StructureElement.Loci.getFirstLocation(selection, location);
            if (!l || selection.elements.length > 1 || StructureProperties.entity.type(l) !== 'polymer') {
                invalid = true;
                return;
            }

            const stats = StructureElement.Stats.ofLoci(selection);
            const counts = structureElementStatsLabel(stats, { countsOnly: true });
            const chain = elementLabel(l, { reverse: true, granularity: 'chain' }).split('|');
            const label = `${counts} | ${chain[0]} | ${chain[chain.length - 1]}`;
            entries.push({ loci: selection, label, cell });
        });

        if (invalid) {
            this.plugin.log.warn('Alignment requires a single polymer chain or residues within one polymer chain.');
            return;
        }
        if (entries.length === 0) {
            this.plugin.log.warn('Select a polymer chain or residue range before using Align.');
            return;
        }
        if (entries.length > 1) {
            this.plugin.log.warn('Alignment requires exactly one selected chain or residue range at a time.');
            return;
        }

        return entries[0];
    }

    private async transform(s: StateObjectRef<PluginStateObject.Molecule.Structure>, matrix: Mat4, coordinateSystem?: SymmetryOperator) {
        const r = StateObjectRef.resolveAndCheck(this.plugin.state.data, s);
        if (!r) return;
        const o = this.plugin.state.data.selectQ(q => q.byRef(r.transform.ref).subtree().withTransformer(StateTransforms.Model.TransformStructureConformation))[0];

        const transform = coordinateSystem && !Mat4.isIdentity(coordinateSystem.matrix)
            ? Mat4.mul(Mat4(), coordinateSystem.matrix, matrix)
            : matrix;

        const params = {
            transform: {
                name: 'matrix' as const,
                params: { data: transform, transpose: false }
            }
        };
        const b = o
            ? this.plugin.state.data.build().to(o).update(params)
            : this.plugin.state.data.build().to(s)
                .insert(StateTransforms.Model.TransformStructureConformation, params, { tags: 'SelectionModeAlignmentTransform' });
        await this.plugin.runTask(this.plugin.state.data.updateTree(b));
    }

    alignSelection = async () => {
        const entry = this.getCurrentAlignmentEntry();
        if (!entry) return;

        const base = this.state.alignBase;
        if (!base) {
            this.setState({ alignBase: entry });
            this.plugin.log.info(`Alignment base set to [${stripTags(entry.label)}]. Select a target and press Align again.`);
            return;
        }

        if (base.loci.structure.root === entry.loci.structure.root) {
            this.plugin.log.warn('Alignment target must be from a different structure than the base selection.');
            return;
        }

        const { query } = StructureSelectionQueries.trace;
        const locis = [base, entry].map(e => {
            const s = StructureElement.Loci.toStructure(e.loci);
            const loci = StructureSelection.toLociWithSourceUnits(query(new QueryContext(s)));
            return StructureElement.Loci.remap(loci, this.getRootStructure(e.loci.structure));
        });

        const pivot = this.plugin.managers.structure.hierarchy.findStructure(locis[0]?.structure);
        const coordinateSystem = pivot?.transform?.cell.obj?.data.coordinateSystem;
        const [{ bTransform, rmsd }] = alignAndSuperpose(locis);

        await this.transform(entry.cell, bTransform, coordinateSystem);
        this.setState({ alignBase: void 0 });
        this.plugin.log.info(`Aligned [${stripTags(entry.label)}] to [${stripTags(base.label)}] with RMSD ${rmsd.toFixed(2)}.`);

        await new Promise(res => requestAnimationFrame(res));
        PluginCommands.Camera.Reset(this.plugin);
    };

    render() {
        const granularity = this.plugin.managers.interactivity.props.granularity;
        const hide = this.plugin.spec.components?.selectionTools?.hide;
        const hasSelection = this.plugin.managers.structure.selection.stats.elementCount > 0;
        const undoTitle = this.state.canUndo
            ? `Undo ${this.plugin.state.data.latestUndoLabel}`
            : 'Some mistakes of the past can be undone.';

        let children: React.ReactNode | undefined = void 0;

        if (this.state.action && !this.state.helper) {
            children = <>
                {(this.state.action && this.state.action !== 'theme' && this.state.action !== 'add-component' && this.state.action !== 'help') && <div className='msp-selection-viewport-controls-actions'>
                    <ActionMenu header={ActionHeader.get(this.state.action as StructureSelectionModifier)} title='Click to close.' items={this.queries} onSelect={this.selectQuery} noOffset />
                    <ActionMenu items={this.helpers} onSelect={this.selectHelper} noOffset />
                </div>}
                {this.state.action === 'theme' && <div className='msp-selection-viewport-controls-actions'>
                    <ControlGroup header='Theme' title='Click to close.' initialExpanded={true} hideExpander={true} hideOffset={true} onHeaderClick={this.toggleTheme} topRightIcon={CloseSvg}>
                        <QuickColorSwatchesControls onApply={this.toggleTheme} />
                        <ApplyThemeControls onApply={this.toggleTheme} />
                    </ControlGroup>
                </div>}
                {this.state.action === 'add-component' && <div className='msp-selection-viewport-controls-actions'>
                    <ControlGroup header='Add Component' title='Click to close.' initialExpanded={true} hideExpander={true} hideOffset={true} onHeaderClick={this.toggleAddComponent} topRightIcon={CloseSvg}>
                        <AddComponentControls onApply={this.toggleAddComponent} forSelection />
                    </ControlGroup>
                </div>}
                {this.state.action === 'help' && <div className='msp-selection-viewport-controls-actions'>
                    <ControlGroup header='Help' title='Click to close.' initialExpanded={true} hideExpander={true} hideOffset={true} onHeaderClick={this.toggleHelp} topRightIcon={CloseSvg} maxHeight='300px'>
                        <HelpGroup header='Selection Operations'>
                            <HelpText>Use <Icon svg={UnionSvg} inline /> <Icon svg={SubtractSvg} inline /> <Icon svg={IntersectSvg} inline /> <Icon svg={SetSvg} inline /> to modify the selection.</HelpText>
                        </HelpGroup>
                        <HelpGroup header='Representation Operations'>
                            <HelpText>Use <Icon svg={BrushSvg} inline /> <Icon svg={GetAppSvg} inline /> <Icon svg={CubeOutlineSvg} inline /> <Icon svg={VisibilityOffOutlinedSvg} inline /> <Icon svg={VisibilityOutlinedSvg} inline /> <Icon svg={RestoreSvg} inline /> to color, export, create components, hide or show the current selection, or undo actions.</HelpText>
                        </HelpGroup>
                        <ViewportHelpContent selectOnly={true} />
                    </ControlGroup>
                </div>}
            </>;
        } else if (ActionHeader.has(this.state.action as any) && this.state.helper === 'residue-list') {
            const close = () => this.setState({ action: void 0, helper: void 0 });
            children = <div className='msp-selection-viewport-controls-actions'>
                <ControlGroup header='Atom/Residue Identifier List' title='Click to close.' initialExpanded={true} hideExpander={true} hideOffset={true} onHeaderClick={close} topRightIcon={CloseSvg}>
                    <ResidueListSelectionHelper modifier={this.state.action as any} plugin={this.plugin} close={close} />
                </ControlGroup>
            </div>;
        }

        return <>
            <div className='msp-flex-row' style={{ background: 'none' }}>
                {(!hide?.granularity) && <PureSelectControl title={`Selection granularity`} param={this.state.structureSelectionParams.granularity} name='granularity' value={granularity} onChange={this.setGranuality} isDisabled={this.isDisabled} />}
                {(!hide?.union) && <ToggleButton icon={UnionSvg} title={`${ActionHeader.get('add')}. Hold shift key to keep menu open.`} toggle={this.toggleAdd} isSelected={this.state.action === 'add'} disabled={this.isDisabled} />}
                {(!hide?.subtract) && <ToggleButton icon={SubtractSvg} title={`${ActionHeader.get('remove')}. Hold shift key to keep menu open.`} toggle={this.toggleRemove} isSelected={this.state.action === 'remove'} disabled={this.isDisabled} />}
                {(!hide?.intersect) && <ToggleButton icon={IntersectSvg} title={`${ActionHeader.get('intersect')}. Hold shift key to keep menu open.`} toggle={this.toggleIntersect} isSelected={this.state.action === 'intersect'} disabled={this.isDisabled} />}
                {(!hide?.set) && <ToggleButton icon={SetSvg} title={`${ActionHeader.get('set')}. Hold shift key to keep menu open.`} toggle={this.toggleSet} isSelected={this.state.action === 'set'} disabled={this.isDisabled} />}

                {(!hide?.theme) && <ToggleButton icon={BrushSvg} title='Apply theme to selection' toggle={this.toggleTheme} isSelected={this.state.action === 'theme'} disabled={this.isDisabled} style={{ marginLeft: '10px' }} />}
                {(!hide?.exportSelection) && <IconButton svg={GetAppSvg} title='Export current selection' onClick={this.exportSelection} disabled={this.isDisabled || !hasSelection} />}
                {(!hide?.componentAdd) && <ToggleButton icon={CubeOutlineSvg} title='Create new component from selection' toggle={this.toggleAddComponent} isSelected={this.state.action === 'add-component'} disabled={this.isDisabled} />}
                {(!hide?.hideSelection) && <IconButton svg={VisibilityOffOutlinedSvg} title='Hide selection' onClick={this.hideSelection} disabled={this.isDisabled} />}
                {(!hide?.showSelection) && <IconButton svg={VisibilityOutlinedSvg} title='Show selection' onClick={this.showSelection} disabled={this.isDisabled} />}
                {(!hide?.saveSelection) && <IconButton svg={SaveOutlinedSvg} title='Save current selection' onClick={this.saveSelection} disabled={this.isDisabled || !hasSelection} />}
                {(!hide?.alignSelection) && <IconButton svg={SuperposeChainsSvg} title={this.state.alignBase ? 'Align current selection to target' : 'Set alignment target to current selection'} onClick={this.alignSelection} disabled={this.isDisabled} toggleState={!!this.state.alignBase} />}
                {(!hide?.undo) && <IconButton svg={RestoreSvg} onClick={this.undo} disabled={!this.state.canUndo || this.isDisabled} title={undoTitle} />}

                {(!hide?.help) && <ToggleButton icon={HelpOutlineSvg} title='Show/hide help' toggle={this.toggleHelp} style={{ marginLeft: '10px' }} isSelected={this.state.action === 'help'} />}
                {((!hide?.cancel) && this.plugin.config.get(PluginConfig.Viewport.ShowSelectionMode)) && (<IconButton svg={CancelOutlinedSvg} title='Turn selection mode off' onClick={this.turnOff} />)}
            </div>
            {children}
        </>;
    }
}

export class StructureSelectionStatsControls extends PluginUIComponent<{ hideOnEmpty?: boolean }, { isEmpty: boolean, isBusy: boolean }> {
    state = {
        isEmpty: true,
        isBusy: false
    };

    componentDidMount() {
        this.subscribe(this.plugin.managers.structure.selection.events.changed, () => {
            this.forceUpdate();
        });

        this.subscribe(this.plugin.managers.structure.hierarchy.behaviors.selection, c => {
            const isEmpty = c.structures.length === 0;
            if (this.state.isEmpty !== isEmpty) {
                this.setState({ isEmpty });
            }
        });

        this.subscribe(this.plugin.behaviors.state.isBusy, v => {
            this.setState({ isBusy: v });
        });
    }

    get isDisabled() {
        return this.state.isBusy || this.state.isEmpty;
    }

    get stats() {
        const stats = this.plugin.managers.structure.selection.stats;
        if (stats.structureCount === 0 || stats.elementCount === 0) {
            return 'Nothing Selected';
        } else {
            return `${stripTags(stats.label)} Selected`;
        }
    }

    clear = () => this.plugin.managers.interactivity.lociSelects.deselectAll();

    focus = () => {
        if (this.plugin.managers.structure.selection.stats.elementCount === 0) return;
        const { sphere } = this.plugin.managers.structure.selection.getBoundary();
        this.plugin.managers.camera.focusSphere(sphere);
    };

    highlight = (e: React.MouseEvent<HTMLElement>) => {
        this.plugin.managers.interactivity.lociHighlights.clearHighlights();
        this.plugin.managers.structure.selection.entries.forEach(e => {
            this.plugin.managers.interactivity.lociHighlights.highlight({ loci: e.selection }, false);
        });
    };

    clearHighlight = () => {
        this.plugin.managers.interactivity.lociHighlights.clearHighlights();
    };

    render() {
        const stats = this.plugin.managers.structure.selection.stats;
        const empty = stats.structureCount === 0 || stats.elementCount === 0;

        if (empty && this.props.hideOnEmpty) return null;

        return <>
            <div className='msp-flex-row'>
                <Button noOverflow onClick={this.focus} title='Click to Focus Selection' disabled={empty} onMouseEnter={this.highlight} onMouseLeave={this.clearHighlight}
                    style={{ textAlignLast: !empty ? 'left' : void 0 }}>
                    {this.stats}
                </Button>
                {!empty && <IconButton svg={CancelOutlinedSvg} onClick={this.clear} title='Clear' className='msp-form-control' flex />}
            </div>
        </>;
    }
}

interface ApplyThemeControlsState {
    values: StructureComponentManager.ThemeParams
}

interface ApplyThemeControlsProps {
    onApply?: () => void
}

const SelectionQuickColors: [string, Color][] = [
    ['Maroon', Color(0x800000)],
    ['Red', Color(0xe6194b)],
    ['Pink', Color(0xfabebe)],
    ['Magenta', Color(0xf032e6)],
    ['Purple', Color(0x911eb4)],
    ['Lavender', Color(0xe6beff)],
    ['Navy', Color(0x000075)],
    ['Blue', Color(0x4363d8)],
    ['Cyan', Color(0x46f0f0)],
    ['Teal', Color(0x008080)],
    ['Mint', Color(0xaaffc3)],
    ['Green', Color(0x3cb44b)],
    ['Lime', Color(0xbcf60c)],
    ['Olive', Color(0x808000)],
    ['Yellow', Color(0xffe119)],
    ['Cream', Color(0xfffac8)],
    ['Apricot', Color(0xffd8b1)],
    ['Orange', Color(0xf58231)],
    ['Brown', Color(0x9a6324)],
    ['White', Color(0xffffff)],
    ['Gray', Color(0x808080)],
    ['Black', Color(0x000000)],
];

const QuickColorSwatchStyle: React.CSSProperties = {
    flex: '0 0 24px',
    minWidth: '24px',
    height: '24px',
    padding: 0,
    border: '1px solid rgba(0, 0, 0, 0.25)'
};

function quickColorSwatchStyle(color: Color): React.CSSProperties {
    return { ...QuickColorSwatchStyle, background: Color.toStyle(color) };
}

class QuickColorSwatchesControls extends PurePluginUIComponent<ApplyThemeControlsProps, ApplyThemeControlsState> {
    _params = memoizeLatest((pivot: StructureRef | undefined) => StructureComponentManager.getThemeParams(this.plugin, pivot));
    get params() { return this._params(this.plugin.managers.structure.component.pivotStructure); }

    state = { values: ParamDefinition.getDefaultValues(this.params) };

    applyQuickColor = (color: Color) => {
        const values = {
            ...this.state.values,
            action: { name: 'color' as const, params: { color } }
        };
        this.plugin.managers.structure.component.applyTheme(values, this.plugin.managers.structure.hierarchy.current.structures);
        this.props.onApply?.();
    };

    render() {
        return <div className='msp-flex-row' style={{ flexWrap: 'wrap', justifyContent: 'center', background: 'none', marginBottom: '1px' }}>
            {SelectionQuickColors.map(([label, color]) => <Button key={label} title={`Apply ${label}`} onClick={() => this.applyQuickColor(color)} style={quickColorSwatchStyle(color)} />)}
        </div>;
    }
}

class ApplyThemeControls extends PurePluginUIComponent<ApplyThemeControlsProps, ApplyThemeControlsState> {
    _params = memoizeLatest((pivot: StructureRef | undefined) => StructureComponentManager.getThemeParams(this.plugin, pivot));
    get params() { return this._params(this.plugin.managers.structure.component.pivotStructure); }

    state = { values: ParamDefinition.getDefaultValues(this.params) };

    apply = () => {
        this.plugin.managers.structure.component.applyTheme(this.state.values, this.plugin.managers.structure.hierarchy.current.structures);
        this.props.onApply?.();
    };

    paramsChanged = (values: any) => this.setState({ values });

    render() {
        return <>
            <ParameterControls params={this.params} values={this.state.values} onChangeValues={this.paramsChanged} />
            <Button icon={BrushSvg} className='msp-btn-commit msp-btn-commit-on' onClick={this.apply} style={{ marginTop: '1px' }}>
                Apply Theme
            </Button>
        </>;
    }
}

const ResidueListIdTypeParams = {
    idType: ParamDefinition.Select<'auth' | 'label' | 'atom-id' | 'element-symbol'>('auth', ParamDefinition.arrayToOptions(['auth', 'label', 'atom-id', 'element-symbol'])),
    identifiers: ParamDefinition.Text('', { description: 'A comma separated list of atom identifiers (e.g. 10, 15-25), element symbols (e.g. N, C or 20-200) or residue ranges in given chain (e.g. A 10-15, B 25, C 30:i)' })
};

const DefaultResidueListIdTypeParams = ParamDefinition.getDefaultValues(ResidueListIdTypeParams);

function ResidueListSelectionHelper({ modifier, plugin, close }: { modifier: StructureSelectionModifier, plugin: PluginContext, close: () => void }) {
    const [state, setState] = React.useState(DefaultResidueListIdTypeParams);

    const apply = () => {
        if (state.identifiers.trim().length === 0) return;

        try {
            close();
            const query = compileIdListSelection(state.identifiers, state.idType);
            plugin.managers.structure.selection.fromCompiledQuery(modifier, query, false);
        } catch (e) {
            console.error(e);
            plugin.log.error('Failed to create selection');
        }
    };

    return <>
        <ParameterControls params={ResidueListIdTypeParams} values={state} onChangeValues={setState} onEnter={apply} />
        <Button className='msp-btn-commit msp-btn-commit-on' disabled={state.identifiers.trim().length === 0} onClick={apply} style={{ marginTop: '1px' }}>
            {capitalize(modifier)} Selection
        </Button>
    </>;
}
