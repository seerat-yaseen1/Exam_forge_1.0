/**
 * The console primitives, mounted.
 *
 * These carry the behaviour that makes the staff consoles usable on a phone
 * and with a keyboard, and every one of the failures below is silent — the
 * component still renders, it is just worse in a way no type checker sees:
 *
 *   • a table cell with no `data-label` becomes an unlabelled value on a
 *     phone, where the column heading it belonged to is no longer on screen;
 *   • a sheet that does not restore focus drops a keyboard user back at the
 *     top of the page every time they close a drawer;
 *   • a tab strip without arrow keys costs one Tab press per tab to pass.
 *
 * The CSS half — that the labelled cell actually becomes a card below 760px —
 * is not asserted here, because jsdom does not do media queries. It is
 * verified in a browser at 390px; this covers the contract the stylesheet
 * depends on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DataTable, Sheet, Tabs, Avatar, type Column } from './data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: React.ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

type Row = { id: string; name: string; role: string; count: number };

const ROWS: Row[] = [
  { id: '1', name: 'Meera Iyer', role: 'Faculty', count: 12 },
  { id: '2', name: 'Rahul Verma', role: 'Admin', count: 3 },
];

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', cell: (r) => r.name, primary: true },
  { key: 'role', header: 'Role', cell: (r) => r.role },
  { key: 'count', header: 'Questions', cell: (r) => r.count, align: 'right' },
];

// ══════════════════════════════════════════════════════════════════

describe('DataTable', () => {
  it('carries every column name onto its cells, which is what the phone layout reads', () => {
    const el = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const firstRow = el.querySelectorAll('tbody tr')[0];
    const labels = [...firstRow.querySelectorAll('td')].map((td) => td.getAttribute('data-label'));

    // Below 760px each of these becomes the label beside its value. A missing
    // one is a number on a card with nothing saying what it counts.
    expect(labels).toEqual(['Name', 'Role', 'Questions']);
  });

  it('marks exactly the identifying column, so a card gets a title', () => {
    const el = render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const primaries = el.querySelectorAll('tbody tr:first-child td[data-primary]');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].textContent).toBe('Meera Iyer');
  });

  it('falls back to an explicit label when the heading is not text', () => {
    // A heading that is an icon or a sort button cannot be read by attr().
    const el = render(
      <DataTable
        columns={[{ key: 'k', header: <span>✓</span>, label: 'Selected', cell: () => 'yes' }]}
        rows={[ROWS[0]]}
        rowKey={(r) => r.id}
      />,
    );
    expect(el.querySelector('td')!.getAttribute('data-label')).toBe('Selected');
  });

  it('makes a clickable row operable by keyboard, not only by pointer', () => {
    const onRowClick = vi.fn();
    const el = render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} />,
    );
    const row = el.querySelector('tbody tr')!;
    expect(row.getAttribute('tabindex')).toBe('0');

    act(() => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0], 0);
  });

  it('renders the empty state instead of a table with no rows', () => {
    const el = render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>No faculty yet</p>}
      />,
    );
    expect(el.querySelector('table')).toBeNull();
    expect(el.textContent).toContain('No faculty yet');
  });
});

describe('Tabs', () => {
  const ITEMS = [
    { key: 'a', label: 'Faculty', count: 4 },
    { key: 'b', label: 'Students', count: 0 },
    { key: 'c', label: 'Schools' },
  ];

  it('keeps only the selected tab in the tab order', () => {
    const el = render(<Tabs items={ITEMS} active="b" onChange={() => {}} label="Sections" />);
    const tabs = [...el.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('moves between tabs with the arrow keys, and wraps', () => {
    const onChange = vi.fn();
    const el = render(<Tabs items={ITEMS} active="c" onChange={onChange} label="Sections" />);
    act(() => {
      el.querySelector('[role="tablist"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('shows a zero count rather than hiding it — "0" is an answer', () => {
    const el = render(<Tabs items={ITEMS} active="a" onChange={() => {}} label="Sections" />);
    expect(el.textContent).toContain('0');
  });
});

describe('Sheet', () => {
  it('locks the page behind it and releases it on close', () => {
    const el = render(
      <Sheet open onClose={() => {}} title="Edit">
        <p>body</p>
      </Sheet>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    expect(el.ownerDocument.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => root!.unmount());
    root = null;
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Edit">
        <p>body</p>
      </Sheet>,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('returns focus to whatever opened it', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    render(
      <Sheet open onClose={() => {}} title="Edit">
        <button type="button">inside</button>
      </Sheet>,
    );
    // Focus moved into the sheet…
    expect(document.activeElement).not.toBe(opener);

    act(() => root!.unmount());
    root = null;
    // …and back out of it, so the next Tab resumes where it left off.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('is announced as a dialog and named by its title', () => {
    const el = render(
      <Sheet open onClose={() => {}} title="Edit faculty">
        <p>body</p>
      </Sheet>,
    );
    const dialog = el.ownerDocument.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby')!;
    expect(el.ownerDocument.getElementById(labelId)!.textContent).toBe('Edit faculty');
  });

  it('renders nothing at all when closed', () => {
    const el = render(
      <Sheet open={false} onClose={() => {}} title="Edit">
        <p>body</p>
      </Sheet>,
    );
    expect(el.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('Avatar', () => {
  it('takes the first letter of the first two words', () => {
    const el = render(<Avatar name="Meera Iyer Krishnan" />);
    expect(el.textContent).toBe('MI');
  });

  it('survives a single name and stray whitespace', () => {
    expect(render(<Avatar name="  Prince  " />).textContent).toBe('P');
  });
});
