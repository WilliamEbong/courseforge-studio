// Original descriptor from; no native template.
import { el, DECL } from './elements.js';
export const PLAYER_PART = 'story/playerProps.xml';
export function playerProperties(style = 'modern', title = 'Untitled', menu = true) {
  const option = (name, value, children = '') => el('option', { name, value }, el('options', {}, children), el('properties'));
  const group = (name, options) => el('optiongroup', { name }, el('options', {}, options));
  return DECL + el('player', { product: 'sl', name: 'CF Player', version: '3' },
    el('control_options', {}, el('valuetypes'), el('optiongroups', {},
      group('sidebaroptions', [option('title_enabled', true, option('title_text', title)),
        option('logo_enabled', false, [option('logo_url', ''), option('html5_logo_url', '')]),
        option('sidebar_enabled', menu, [option('sidebarpos', 'left'), option('closed', false)]),
        el('optionlist', { name: 'tabs' }, el('listitems', {}, el('listitem', { name: 'outline', index: 0, value: menu, group: 'sidebar' })))]),
      group('menuoptions', option('flow', 'free')),
      group('bottombaroptions', option('bottombar_enabled', true)),
      group('controls', ['volume', 'pauseplay', 'closed_captions', 'settings', 'seekbar'].map(n => option(n, n !== 'seekbar'))),
      group('buttonoptions', ['next', 'previous', 'submit'].map(n => option(n, 'icontext'))))),
    el('playerType', {}, style === 'modern' ? 'unified' : 'classic'), el('themeKind', {}, 'dark'),
    el('navigationsettings', {}, el('browsersettings', { modernplayersize: 'Scaled' }), el('resumesettings', { restartresume: 'Prompt', ignorecookie: true })),
    el('accessibilitysettings', { skipnavigation: true }));
}
