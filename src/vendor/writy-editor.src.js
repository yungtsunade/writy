// Writy editor: CodeMirror 6 with an Obsidian-like live preview for Markdown.
import {EditorState, Annotation, EditorSelection, Prec} from '@codemirror/state';
import {EditorView, keymap, placeholder as phExt, Decoration, ViewPlugin, WidgetType} from '@codemirror/view';
import {history, defaultKeymap, historyKeymap, indentMore, indentLess} from '@codemirror/commands';
import {syntaxTree, indentUnit} from '@codemirror/language';
import {markdown, markdownLanguage} from '@codemirror/lang-markdown';
import {Strikethrough} from '@lezer/markdown';

const External = Annotation.define();

/* ==highlight== as an inline extension */
const HighlightDelim = {resolve: 'Highlight', mark: 'HighlightMark'};
const Highlight = {
  defineNodes: ['Highlight', 'HighlightMark'],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos){
      if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const canOpen = !/\s|^$/.test(after), canClose = !/\s|^$/.test(before);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, canOpen, canClose);
    },
    after: 'Emphasis'
  }]
};

class BulletWidget extends WidgetType {
  constructor(level){ super(); this.level = level; }
  eq(o){ return o.level === this.level; }
  toDOM(){ const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = ['•','◦','▪'][this.level % 3]; return s; }
}
class EmptyWidget extends WidgetType { toDOM(){ return document.createElement('span'); } eq(){ return true; } }
const empty = Decoration.replace({widget: new EmptyWidget()});
const hide = Decoration.replace({});

const MARKS = new Set(['EmphasisMark','StrikethroughMark','CodeMark','HighlightMark','LinkMark']);
const STYLE = {
  StrongEmphasis: 'cm-strong', Emphasis: 'cm-em', Strikethrough: 'cm-strike',
  InlineCode: 'cm-icode', Highlight: 'cm-mark'
};

function touches(sel, from, to){
  for (const r of sel.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function buildDecos(view){
  const {state} = view, sel = state.selection, decos = [];
  const activeLines = new Set();
  for (const r of sel.ranges){
    const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) activeLines.add(i);
  }
  const lineActive = pos => activeLines.has(state.doc.lineAt(pos).number);
  const focused = view.hasFocus;
  const seenLi = new Set();
  for (const {from, to} of view.visibleRanges){
    syntaxTree(state).iterate({from, to, enter(node){
      const n = node.name;
      // headings
      const h = /^ATXHeading(\d)$/.exec(n);
      if (h){
        const line = state.doc.lineAt(node.from);
        decos.push(Decoration.line({class: 'cm-h cm-h' + h[1]}).range(line.from));
        return;
      }
      if (n === 'HeaderMark'){
        const parent = node.node.parent;
        if (parent && /^ATXHeading/.test(parent.name) && !(focused && lineActive(node.from))){
          let end = node.to; if (state.doc.sliceString(end, end + 1) === ' ') end++;
          if (node.from === state.doc.lineAt(node.from).from) decos.push(hide.range(node.from, end));
          else decos.push(hide.range(node.from, node.to));
        } else decos.push(Decoration.mark({class:'cm-fmark'}).range(node.from, node.to));
        return;
      }
      if (n === 'Link' || n === 'Image'){
        if (!node.node.getChild('URL')) return false;          // [Text] ohne Adresse: normaler Text
        decos.push(Decoration.mark({class: 'cm-link'}).range(node.from, node.to));
      }
      if (STYLE[n]){ if (node.to > node.from) decos.push(Decoration.mark({class: STYLE[n]}).range(node.from, node.to)); }
      if (MARKS.has(n)){
        const parent = node.node.parent;
        const pf = parent ? parent.from : node.from, pt = parent ? parent.to : node.to;
        if (!(focused && touches(sel, pf, pt))) decos.push(hide.range(node.from, node.to));
        else decos.push(Decoration.mark({class:'cm-fmark'}).range(node.from, node.to));
        return;
      }
      if (n === 'URL' && node.node.parent && node.node.parent.name === 'Link'){
        const p = node.node.parent;
        if (!(focused && touches(sel, p.from, p.to))) decos.push(hide.range(node.from, node.to));
        else decos.push(Decoration.mark({class:'cm-fmark'}).range(node.from, node.to));
        return;
      }
      if (n === 'Blockquote'){
        for (let pos = node.from; pos <= node.to;){
          const line = state.doc.lineAt(pos);
          decos.push(Decoration.line({class:'cm-quote'}).range(line.from));
          if (line.to + 1 > node.to) break; pos = line.to + 1;
        }
      }
      if (n === 'QuoteMark'){
        if (!(focused && lineActive(node.from))){
          let end = node.to; if (state.doc.sliceString(end, end + 1) === ' ') end++;
          decos.push(hide.range(node.from, end));
        } else decos.push(Decoration.mark({class:'cm-fmark'}).range(node.from, node.to));
        return;
      }
      if (n === 'HorizontalRule'){
        const line = state.doc.lineAt(node.from);
        if (!(focused && lineActive(node.from))){
          decos.push(Decoration.line({class:'cm-hr'}).range(line.from));
          decos.push(empty.range(node.from, node.to));
        }
        return false;
      }
      if (n === 'ListItem'){
        const line = state.doc.lineAt(node.from);
        let depth = 0; for (let p = node.node.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
        if (line.from <= node.from && !seenLi.has(line.from)){
          seenLi.add(line.from);
          decos.push(Decoration.line({class:'cm-li', attributes:{style:'padding-left:' + (1.6 + (depth - 1) * 1.7).toFixed(2) + 'em'}}).range(line.from));
          const ws = /^\s*/.exec(line.text)[0].length;
          if (ws > 0 && line.from + ws <= node.from + ws) decos.push(hide.range(line.from, line.from + ws));
        }
      }
      if (n === 'ListMark'){
        const list = node.node.parent && node.node.parent.parent;
        let depth = -1; for (let p = list; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
        if (list && list.name === 'BulletList'){
          decos.push(Decoration.replace({widget: new BulletWidget(Math.max(0, depth))}).range(node.from, node.to));
        } else decos.push(Decoration.mark({class:'cm-num'}).range(node.from, node.to));
        return;
      }
      if (n === 'FencedCode' || n === 'CodeBlock'){
        for (let pos = node.from; pos <= node.to;){
          const line = state.doc.lineAt(pos);
          decos.push(Decoration.line({class:'cm-codeblock'}).range(line.from));
          if (line.to + 1 > node.to) break; pos = line.to + 1;
        }
        return false;
      }
    }});
  }
  return Decoration.set(decos, true);
}

const livePreview = ViewPlugin.fromClass(class {
  constructor(view){ this.decorations = buildDecos(view); }
  update(u){ if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = buildDecos(u.view); }
}, {decorations: v => v.decorations});

/* -> → and friends */
function inCode(state, pos){
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent)
    if (['InlineCode','FencedCode','CodeBlock','CodeText'].includes(n.name)) return true;
  return false;
}
const arrows = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '>' && text !== '-' ) return false;
  if (from !== to) return false;
  const st = view.state, p1 = st.doc.sliceString(Math.max(0, from - 1), from), p2 = st.doc.sliceString(Math.max(0, from - 2), from);
  let back = 0, ins = null;
  if (text === '>'){
    if (p2 === '<=') { back = 2; ins = '⇔'; }
    else if (p1 === '←') { back = 1; ins = '↔'; }
    else if (p1 === '-' && p2 !== '--') { back = 1; ins = '→'; }
    else if (p1 === '=') { back = 1; ins = '⇒'; }
  } else if (text === '-'){
    if (p1 === '<') { back = 1; ins = '←'; }
  }
  if (!ins || inCode(st, from)) return false;
  view.dispatch({changes: {from: from - back, to, insert: ins}, selection: {anchor: from - back + ins.length}, userEvent: 'input.type'});
  return true;
});

/* Ctrl+B / Ctrl+I */
function toggleWrap(mark){
  return view => {
    const st = view.state, L = mark.length;
    const tr = st.changeByRange(r => {
      const before = st.doc.sliceString(r.from - L, r.from), after = st.doc.sliceString(r.to, r.to + L);
      if (before === mark && after === mark)
        return {changes: [{from: r.from - L, to: r.from}, {from: r.to, to: r.to + L}], range: sel(r.from - L, r.to - L)};
      return {changes: [{from: r.from, insert: mark}, {from: r.to, insert: mark}], range: sel(r.from + L, r.to + L)};
    });
    view.dispatch(st.update(tr, {userEvent: 'input'}));
    return true;
  };
}
const sel = (a, b) => EditorSelection.range(a, b);


/* lists: continue, end, renumber, indent (like Notion/Obsidian) */
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)/;
function parseLine(text){
  const m = ITEM.exec(text); if (!m) return null;
  return {indent: m[1], bullet: m[2] || null, n: m[3] ? +m[3] : null, sep: m[4] || '', len: m[0].length};
}
const deeper = (t, indent) => t.trim() !== '' && t.startsWith(indent) && /^\s/.test(t.slice(indent.length));
function nextNumber(doc, lineNo, indent){
  for (let i = lineNo - 1; i >= 1; i--){
    const t = doc.line(i).text, p = parseLine(t);
    if (p && p.n !== null && p.indent === indent) return p.n + 1;
    if (deeper(t, indent)) continue;
    break;
  }
  return 1;
}
function renumberChanges(doc, startLine, indent, n){
  const ch = [];
  for (let i = startLine; i <= doc.lines; i++){
    const L = doc.line(i), p = parseLine(L.text);
    if (p && p.n !== null && p.indent === indent){
      if (p.n !== n) ch.push({from: L.from + indent.length, to: L.from + indent.length + String(p.n).length, insert: String(n)});
      n++; continue;
    }
    if (deeper(L.text, indent)) continue;
    break;
  }
  return ch;
}
function listEnter(view){
  const st = view.state, r = st.selection.main; if (!r.empty) return false;
  const L = st.doc.lineAt(r.head), p = parseLine(L.text);
  if (!p){
    const q = /^(\s*>\s?)/.exec(L.text);
    if (!q || r.head < L.from + q[0].length) return false;
    if (L.text.slice(q[0].length).trim() === ''){ view.dispatch({changes: {from: L.from, to: L.to, insert: ''}, selection: {anchor: L.from}, userEvent: 'input'}); return true; }
    const ins = '\n' + q[1].replace(/\s?$/, ' ');
    view.dispatch({changes: {from: r.head, insert: ins}, selection: {anchor: r.head + ins.length}, scrollIntoView: true, userEvent: 'input'}); return true;
  }
  if (r.head < L.from + p.len) return false;
  if (L.text.slice(p.len).trim() === ''){
    if (p.indent.length >= 4){
      const ni = p.indent.slice(4);
      const mk = p.n === null ? p.bullet + ' ' : nextNumber(st.doc, L.number, ni) + p.sep + ' ';
      const changes = [{from: L.from, to: L.to, insert: ni + mk}];
      if (p.n !== null) changes.push(...renumberChanges(st.doc, L.number + 1, ni, parseInt(mk) + 1));
      view.dispatch({changes, selection: {anchor: L.from + ni.length + mk.length}, userEvent: 'input'});
    } else view.dispatch({changes: {from: L.from, to: L.to, insert: ''}, selection: {anchor: L.from}, userEvent: 'input'});
    return true;
  }
  const mk = p.n === null ? p.bullet + ' ' : (p.n + 1) + p.sep + ' ';
  const ins = '\n' + p.indent + mk;
  const changes = [{from: r.head, insert: ins}];
  if (p.n !== null) changes.push(...renumberChanges(st.doc, L.number + 1, p.indent, p.n + 2));
  view.dispatch({changes, selection: {anchor: r.head + ins.length}, scrollIntoView: true, userEvent: 'input'});
  return true;
}
function listBackspace(view){
  const st = view.state, r = st.selection.main; if (!r.empty) return false;
  const L = st.doc.lineAt(r.head), p = parseLine(L.text);
  if (!p || r.head !== L.from + p.len) return false;
  const changes = [{from: L.from, to: L.from + p.len, insert: ''}];
  if (p.n !== null) changes.push(...renumberChanges(st.doc, L.number + 1, p.indent, p.n));
  view.dispatch({changes, userEvent: 'delete'});
  return true;
}
function listIndent(view, out){
  const st = view.state, r = st.selection.main;
  const L = st.doc.lineAt(r.head);
  if (st.doc.lineAt(r.anchor).number !== L.number) return out ? indentLess(view) : indentMore(view);
  const p = parseLine(L.text);
  if (!p){
    if (out) return indentLess(view);
    view.dispatch(st.replaceSelection('    ')); return true;
  }
  const changes = [];
  if (!out){
    changes.push({from: L.from, insert: '    '});
    if (p.n !== null){
      changes.push({from: L.from + p.indent.length, to: L.from + p.indent.length + String(p.n).length, insert: '1'});
      changes.push(...renumberChanges(st.doc, L.number + 1, p.indent, nextNumber(st.doc, L.number, p.indent)));
    }
  } else {
    if (p.indent.length < 4) return true;
    const ni = p.indent.slice(4);
    changes.push({from: L.from, to: L.from + 4, insert: ''});
    if (p.n !== null){
      const nn = nextNumber(st.doc, L.number, ni);
      changes.push({from: L.from + p.indent.length, to: L.from + p.indent.length + String(p.n).length, insert: String(nn)});
      changes.push(...renumberChanges(st.doc, L.number + 1, ni, nn + 1));
    }
  }
  view.dispatch({changes, userEvent: 'input'});
  return true;
}
const tabKeys = [
  {key: 'Enter', run: listEnter},
  {key: 'Backspace', run: listBackspace},
  {key: 'Tab', run: v => listIndent(v, false)},
  {key: 'Shift-Tab', run: v => listIndent(v, true)},
  {key: 'Mod-b', run: toggleWrap('**')},
  {key: 'Mod-i', run: toggleWrap('*')}
];

function create(parent, opts = {}){
  let onChange = opts.onChange || (() => {});
  const extensions = [
        history(),
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        markdown({base: markdownLanguage, extensions: [Strikethrough, Highlight], addKeymap: false}),
        Prec.high(keymap.of(tabKeys)),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        phExt(opts.placeholder || ''),
        EditorView.contentAttributes.of({spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', lang: 'de'}),
        arrows,
        livePreview,
        EditorView.updateListener.of(u => {
          if (u.docChanged && !u.transactions.some(t => t.annotation(External))) onChange(u);
        })
  ];
  const view = new EditorView({parent, state: EditorState.create({doc: opts.doc || '', extensions})});
  const api = {
    view,
    get value(){ return view.state.doc.toString(); },
    set value(v){
      const cur = view.state.doc.toString(); if (v === cur) return;
      const h = Math.min(view.state.selection.main.head, v.length);
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: v}, selection: {anchor: h}, annotations: External.of(true)});
    },
    load(v){ // switch to another document: fresh undo history
      view.setState(EditorState.create({doc: v, extensions}));
    },
    get selectionStart(){ return view.state.selection.main.from; },
    get selectionEnd(){ return view.state.selection.main.to; },
    setSelectionRange(a, b){ const L = view.state.doc.length; view.dispatch({selection: {anchor: Math.min(a, L), head: Math.min(b, L)}}); },
    focus(){ view.focus(); },
    select(){ view.dispatch({selection: {anchor: 0, head: view.state.doc.length}}); view.focus(); },
    set scrollTop(v){ view.scrollDOM.scrollTop = v; },
    get scrollTop(){ return view.scrollDOM.scrollTop; },
    setOnChange(f){ onChange = f; },
    get hasFocus(){ return view.hasFocus; },
    dom: view.dom
  };
  return api;
}
window.WrityEditor = {create};
