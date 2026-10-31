import { Fragment, h, setReact } from './jsx.js';
export default function setup(bridge) {
    setReact(bridge.React);
    const { useState, useEffect } = bridge.React;
    const { IconButton, Badge, Switch, Field, TextField, Button } = bridge.kit;
    const { t } = bridge.i18n;
    const notes = bridge.storage.user;
    const noteKey = (sid) => `note.${sid}`;
    // ---------- ? 붙여 보내기 ----------
    const ask = (c) => {
        const text = c.text.trim();
        if (!text)
            return;
        void bridge.actions.dispatch('composer.submit', { sid: c.sid, text: text.endsWith('?') ? text : `${text}?` });
    };
    bridge.slots.register('composer.actions', {
        id: 'ask',
        order: { before: 'send' },
        render: () => {
            const c = bridge.slots.useSlotContext();
            return h(IconButton, { icon: "info", label: t('ask'), keepFocus: true, disabled: c.disabled || !c.text.trim(), onClick: () => ask(c) });
        },
        menu: { label: t('ask'), icon: 'info', enabled: (c) => !!c.text.trim(), run: ask },
    });
    bridge.commands.register({
        id: 'ask',
        title: t('ask'),
        keys: 'Alt+Shift+Q',
        when: (ctx) => ctx.focused === 'composer',
        run: (ctx) => ask(ctx.composer),
    });
    // ---------- a note per session ----------
    // Every page that shows the list shares one fetch of which sessions have a note.
    const useNoted = () => bridge.data.shared('noted', () => notes.list('note.'), 30_000) ?? [];
    function NoteSheet({ sid, close }) {
        const [text, setText] = useState('');
        const [version, setVersion] = useState();
        useEffect(() => {
            void notes.get(noteKey(sid)).then((it) => {
                if (!it)
                    return;
                setText(String(it.value));
                setVersion(it.version);
            });
        }, [sid]);
        const save = async () => {
            // ifVersion: another page that saved meanwhile is not overwritten (it throws instead).
            if (text.trim())
                await notes.set(noteKey(sid), text, version === undefined ? {} : { ifVersion: version });
            else
                await notes.delete(noteKey(sid));
            bridge.ui.toast(t('saved'), { tone: 'ok' });
            close();
        };
        return (h(Fragment, null,
            h(Field, null,
                h(TextField, { value: text, onChange: setText, rows: 5, placeholder: t('notePlaceholder'), autoFocus: true })),
            h(Button, { tone: "primary", block: true, onClick: () => void save() }, t('save'))));
    }
    bridge.slots.register('session.menu', {
        id: 'note',
        order: { after: 'rename' },
        label: t('note'),
        icon: 'doc',
        run: (ctx) => bridge.ui.sheet.open(NoteSheet, { sid: ctx.sid }, { title: t('noteTitle') }),
    });
    bridge.slots.register('session-list.row.badges', {
        id: 'note',
        render: () => {
            const { session } = bridge.slots.useSlotContext();
            return useNoted().includes(noteKey(session.id)) ? h(Badge, { tone: "blue" }, t('note')) : null;
        },
    });
    // ---------- turn-end notice ----------
    let notify = false;
    void notes.get('notify').then((it) => (notify = it?.value === true));
    function NotifySetting() {
        const [on, setOn] = useState(notify);
        const change = (v) => {
            setOn((notify = v));
            void notes.set('notify', v);
        };
        return (h(Field, { hint: t('notifyHint') },
            h(Switch, { checked: on, onChange: change, label: t('notifyDone') })));
    }
    bridge.slots.register('settings.section', { id: 'notify', tab: 'plugins', render: () => h(NotifySetting, null) });
    // primaryOnly: one page of this browser; claim: one browser of this person (a phone and a Mac both open).
    bridge.actions.after('session.done', (ev) => {
        if (!notify)
            return;
        void bridge.events.claim(ev.id).then((first) => first && bridge.ui.toast(`${t('done')}: ${ev.session.title || ev.session.cwd}`));
    }, { primaryOnly: true });
    // ---------- ```checklist ----------
    // "- [x] done" / "- [ ] to do" lines; anything else goes on to the page's own drawing.
    function Checklist({ text }) {
        const items = text.split('\n').map((l) => /^\s*[-*] \[( |x|X)\] (.*)$/.exec(l)).filter((m) => m !== null);
        return (h("ul", { className: "md-list", style: { listStyle: 'none', paddingLeft: 0 } }, items.map((m, i) => (h("li", { key: i },
            h("input", { type: "checkbox", checked: m[1] !== ' ', readOnly: true }),
            " ",
            m[2])))));
    }
    bridge.actions.around('renderer.block', (a, next) => (a.lang === 'checklist' && a.closed ? h(Checklist, { text: a.text }) : next(a)));
}
