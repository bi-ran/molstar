/**
 * Copyright (c) 2019-2026 mol* contributors, licensed under MIT, See LICENSE file for more info.
 */

import { Loci } from '../../mol-model/loci';
import { StructureElement } from '../../mol-model/structure';
import { PluginStateObject } from '../../mol-plugin-state/objects';
import { StateTransforms } from '../../mol-plugin-state/transforms';
import { PluginCommands } from '../../mol-plugin/commands';
import { PluginContext } from '../../mol-plugin/context';
import { StateObjectCell, StateSelection, StateTransform } from '../../mol-state';
import { arraySetAdd } from '../../mol-util/array';
import { CollapsableControls, PurePluginUIComponent } from '../base';
import { Button, IconButton } from '../controls/common';
import { DeleteOutlinedSvg, SaveOutlinedSvg, SetSvg } from '../controls/icons';

const SavedSelectionGroupTag = 'molsight-saved-selection-group';
export const SavedSelectionTag = 'molsight-saved-selection';

type SavedSelectionCell = StateObjectCell<PluginStateObject.Molecule.Structure.Selections>

function getSavedSelectionCells(plugin: PluginContext): SavedSelectionCell[] {
    return plugin.state.data.select(StateSelection.Generators.ofType(PluginStateObject.Molecule.Structure.Selections).withTag(SavedSelectionTag)) as SavedSelectionCell[];
}

function getGroup(plugin: PluginContext) {
    const state = plugin.state.data;
    const groupRef = StateSelection.findTagInSubtree(state.tree, StateTransform.RootRef, SavedSelectionGroupTag);
    const builder = state.build();

    if (groupRef) return builder.to(groupRef);
    return builder.toRoot().group(StateTransforms.Misc.CreateGroup, { label: 'Saved Selections' }, { tags: SavedSelectionGroupTag });
}

export async function saveCurrentSelection(plugin: PluginContext) {
    const selections: { key: string, ref: string, bundle: StructureElement.Bundle }[] = [];
    const dependsOn: string[] = [];
    let totalSize = 0;
    let index = 0;

    plugin.managers.structure.selection.entries.forEach(({ selection }, ref) => {
        if (StructureElement.Loci.isEmpty(selection)) return;
        selections.push({ key: `s${index++}`, ref, bundle: StructureElement.Bundle.fromLoci(selection) });
        totalSize += StructureElement.Loci.size(selection);
        arraySetAdd(dependsOn, ref);
    });

    if (selections.length === 0) {
        plugin.log.warn('No current selection to save.');
        return;
    }

    const label = `Saved Selection ${getSavedSelectionCells(plugin).length + 1}`;
    const update = getGroup(plugin)
        .apply(StateTransforms.Model.MultiStructureSelectionFromBundle, {
            selections,
            isTransitive: true,
            label
        }, { dependsOn, tags: SavedSelectionTag });

    await PluginCommands.State.Update(plugin, { state: plugin.state.data, tree: update, options: { doNotLogTiming: true } });
    plugin.log.info(`Saved ${totalSize} selected element${totalSize === 1 ? '' : 's'} as ${label}.`);
}

export class StructureSavedSelectionsControls extends CollapsableControls {
    defaultState() {
        return {
            isCollapsed: false,
            header: 'Saved Selections',
            brand: { accent: 'gray' as const, svg: SaveOutlinedSvg }
        };
    }

    renderControls() {
        return <SavedSelectionsControls />;
    }
}

class SavedSelectionsControls extends PurePluginUIComponent<{}, { isBusy: boolean }> {
    state = { isBusy: false };

    componentDidMount() {
        this.subscribe(this.plugin.state.data.events.changed, () => this.forceUpdate());
        this.subscribe(this.plugin.managers.structure.selection.events.changed, () => this.forceUpdate());
        this.subscribe(this.plugin.behaviors.state.isBusy, isBusy => this.setState({ isBusy }));
    }

    save = () => {
        saveCurrentSelection(this.plugin);
    };

    render() {
        const cells = getSavedSelectionCells(this.plugin);
        const hasSelection = this.plugin.managers.structure.selection.stats.elementCount > 0;

        return <>
            <Button icon={SaveOutlinedSvg} className='msp-btn msp-btn-block' onClick={this.save} disabled={this.state.isBusy || !hasSelection}>
                Save Current Selection
            </Button>
            <div style={{ marginTop: '6px' }}>
                {cells.length === 0
                    ? <div className='msp-help-text'>No saved selections.</div>
                    : cells.map(cell => <SavedSelectionEntry key={cell.transform.ref} cell={cell} />)}
            </div>
        </>;
    }
}

class SavedSelectionEntry extends PurePluginUIComponent<{ cell: SavedSelectionCell }> {
    private get locis() {
        return this.props.cell.obj?.data.map(e => e.loci) || [];
    }

    select = () => {
        this.plugin.managers.structure.selection.fromSelections(this.props.cell);
    };

    delete = () => {
        PluginCommands.State.RemoveObject(this.plugin, { state: this.plugin.state.data, ref: this.props.cell.transform.ref });
    };

    focus = () => {
        const sphere = Loci.getBundleBoundingSphere({ loci: this.locis });
        if (sphere) this.plugin.managers.camera.focusSphere(sphere);
    };

    highlight = () => {
        for (const loci of this.locis) {
            this.plugin.managers.interactivity.lociHighlights.highlight({ loci }, false);
        }
    };

    clearHighlight = () => {
        this.plugin.managers.interactivity.lociHighlights.clearHighlights();
    };

    render() {
        const label = this.props.cell.obj?.label || 'Saved Selection';

        return <div className='msp-flex-row' onMouseEnter={this.highlight} onMouseLeave={this.clearHighlight}>
            <Button noOverflow title='Click to focus. Hover to highlight.' onClick={this.focus} style={{ width: 'auto', textAlign: 'left' }}>
                {label}
            </Button>
            <IconButton svg={SetSvg} small className='msp-form-control' onClick={this.select} flex title='Select This' />
            <IconButton svg={DeleteOutlinedSvg} small className='msp-form-control' onClick={this.delete} flex title='Delete' />
        </div>;
    }
}
