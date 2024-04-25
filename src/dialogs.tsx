import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import type { CommandRegistry } from '@lumino/commands';
import {
  SessionContextDialogs,
  ISessionContextDialogs,
  ISessionContext,
  SessionContext,
  Dialog,
  ReactWidget
} from '@jupyterlab/apputils';
import { Kernel } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import {
  ITranslator,
  nullTranslator,
  TranslationBundle
} from '@jupyterlab/translation';

import { KernelTable } from './launcher';
import {
  IItem,
  ILastUsedDatabase,
  IFavoritesDatabase,
  ILauncherDatabase,
  IKernelItem,
  MAIN_PLUGIN_ID
} from './types';
import { Item } from './item';
import type { ILauncher } from '@jupyterlab/launcher';
import { JSONExt, ReadonlyJSONValue } from '@lumino/coreutils';
import * as React from 'react';

class CustomSessionContextDialogs extends SessionContextDialogs {
  constructor(protected options: CustomSessionContextDialogs.IOptions) {
    super(options);
    const translator = options.translator ?? nullTranslator;
    this.trans = translator.load('jupyterlab');
  }
  /**
   * Select a kernel for the session.
   */
  async selectKernel(sessionContext: ISessionContext): Promise<void> {
    const trans = this.trans;
    if (sessionContext.isDisposed) {
      return Promise.resolve();
    }

    // If there is no existing kernel, offer the option
    // to keep no kernel.
    let label = trans.__('Cancel');
    if (sessionContext.hasNoKernel) {
      label = sessionContext.kernelDisplayName;
    }
    const buttons = [
      Dialog.cancelButton({
        label
      }),
      Dialog.okButton({
        label: trans.__('Select'),
        ariaLabel: trans.__('Select Kernel'),
        className: 'jp-KernelSelector-SelectButton'
      })
    ];

    const autoStartDefault = sessionContext.kernelPreference.autoStartDefault;
    const hasCheckbox = typeof autoStartDefault === 'boolean';
    const settings = await this.options.settingRegistry.load(MAIN_PLUGIN_ID);

    const dialog = new Dialog<Partial<Kernel.IModel> | null>({
      title: trans.__('Select Kernel'),
      body: new KernelSelector({
        data: {
          specs: sessionContext.specsManager.specs,
          sessions: sessionContext.sessionManager.running(),
          preference: sessionContext.kernelPreference
        },
        commands: this.options.commands,
        favoritesDatabase: this.options.database.favorites,
        lastUsedDatabase: this.options.database.lastUsed,
        settings,
        trans,
        acceptDialog: () => {
          dialog.resolve(1);
        }
      }),
      buttons,
      checkbox: hasCheckbox
        ? {
            label: trans.__('Always start the preferred kernel'),
            caption: trans.__(
              'Remember my choice and always start the preferred kernel'
            ),
            checked: autoStartDefault
          }
        : null
    });
    dialog.node.classList.add('jp-KernelSelector-Dialog');

    const result = await dialog.launch();

    if (sessionContext.isDisposed || !result.button.accept) {
      return;
    }

    if (hasCheckbox && result.isChecked !== null) {
      sessionContext.kernelPreference = {
        ...sessionContext.kernelPreference,
        autoStartDefault: result.isChecked
      };
    }

    const model = result.value;
    if (model === null && !sessionContext.hasNoKernel) {
      return sessionContext.shutdown();
    }
    if (model) {
      await sessionContext.changeKernel(model);
    }
  }
  private trans: TranslationBundle;
}

export namespace CustomSessionContextDialogs {
  export interface IOptions extends ISessionContext.IDialogsOptions {
    database: ILauncherDatabase;
    commands: CommandRegistry;
    settingRegistry: ISettingRegistry;
  }
}

/**
 * Initialization data for the jupyterlab-new-launcher session dialogs.
 */
export const sessionDialogsPlugin: JupyterFrontEndPlugin<ISessionContextDialogs> =
  {
    id: 'jupyterlab-new-launcher:dialogs',
    description: 'Session dialogs for redesigned JupyterLab launcher',
    provides: ISessionContextDialogs,
    autoStart: true,
    requires: [ITranslator, ILauncherDatabase, ISettingRegistry],
    activate: (
      app: JupyterFrontEnd,
      translator: ITranslator,
      database: ILauncherDatabase,
      settingRegistry: ISettingRegistry
    ) => {
      return new CustomSessionContextDialogs({
        translator: translator,
        database: database,
        commands: app.commands,
        settingRegistry: settingRegistry
      });
    }
  };

export class KernelSelector extends ReactWidget {
  constructor(protected options: KernelSelector.IOptions) {
    super();
    this.commands = options.commands;
    this._lastUsedDatabase = options.lastUsedDatabase;
    this._favoritesDatabase = options.favoritesDatabase;
    this._settings = options.settings;
    this.trans = options.trans;
  }
  private _lastUsedDatabase: ILastUsedDatabase;
  private _favoritesDatabase: IFavoritesDatabase;
  trans: TranslationBundle;

  renderKernelCommand = (item: ILauncher.IItemOptions): IItem => {
    return new Item({
      item,
      cwd: '',
      commands: this.commands,
      lastUsedDatabase: this._lastUsedDatabase,
      favoritesDatabase: this._favoritesDatabase
    });
  };

  /**
   * Render the launcher to virtual DOM nodes.
   */
  protected render(): React.ReactElement<any> | null {
    const items: ILauncher.IItemOptions[] = [];
    const specs = this.options.data.specs!.kernelspecs!;

    for (const spec of Object.values(specs)) {
      if (!spec) {
        continue;
      }
      const kernelIconUrl =
        spec.resources['logo-svg'] || spec.resources['logo-64x64'];
      items.push({
        command: 'notebook:create-new',
        args: {
          isLauncher: true,
          kernelName: spec.name
        },
        kernelIconUrl,
        metadata: {
          kernel: JSONExt.deepCopy(spec.metadata || {}) as ReadonlyJSONValue
        }
      });
    }
    const runningItems: ILauncher.IItemOptions[] = [];
    for (const model of this.options.data.sessions!) {
      const kernel = model.kernel;
      if (!kernel) {
        continue;
      }
      const spec = specs[kernel.name]!;
      const kernelIconUrl =
        spec.resources['logo-svg'] || spec.resources['logo-64x64'];
      runningItems.push({
        command: 'notebook:create-new',
        args: {
          isLauncher: true,
          kernelName: spec.name
        },
        kernelIconUrl,
        metadata: {
          kernel: {
            ...JSONExt.deepCopy(spec.metadata || {}),
            state: kernel.execution_state ?? 'running',
            'used by': model.name
          } as ReadonlyJSONValue,
          model: kernel as unknown as ReadonlyJSONValue
        }
      });
    }
    const notebookItems = items.map(this.renderKernelCommand);
    const runningKernelsItems = runningItems.map(this.renderKernelCommand);

    return (
      <>
        <h3 className="jp-KernelSelector-Section">
          {this.trans.__('Start a new kernel')}
        </h3>
        <KernelTable
          trans={this.trans}
          commands={this.commands}
          items={notebookItems}
          settings={this._settings}
          query=""
          showSearchBox={true}
          onClick={item => {
            this._selection = item;
            this.options.acceptDialog();
          }}
        />
        {runningKernelsItems.length > 0 ? (
          <>
            <h3 className="jp-KernelSelector-Section">
              {this.trans.__('Connect to a running kernel')}
            </h3>
            <KernelTable
              trans={this.trans}
              commands={this.commands}
              items={runningKernelsItems}
              settings={this._settings}
              query=""
              showSearchBox={false}
              onClick={item => {
                this._selection = item;
                this.options.acceptDialog();
              }}
              hideColumns={['last-used', 'star']}
            />
          </>
        ) : null}
      </>
    );
  }

  getValue(): Partial<Kernel.IModel> | null {
    if (!this._selection) {
      return null;
    }
    if (this._selection.metadata?.model) {
      return this._selection.metadata.model as unknown as Kernel.IModel;
    }
    return { name: this._selection.args!.kernelName as string };
  }

  protected commands: CommandRegistry;
  private _settings: ISettingRegistry.ISettings;
  private _selection: IKernelItem | null = null;
}

export namespace KernelSelector {
  export interface IOptions {
    lastUsedDatabase: ILastUsedDatabase;
    favoritesDatabase: IFavoritesDatabase;
    settings: ISettingRegistry.ISettings;
    commands: CommandRegistry;
    trans: TranslationBundle;
    data: SessionContext.IKernelSearch;
    acceptDialog: () => void;
  }
}
