import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader, PageSubtitle } from "../src/components/primitives/page-header";
import { PageTab, PageTabPanel, PageTabs } from "../src/components/primitives/page-tabs";
import { Modal, ModalDialog, ModalCard, ModalHead, ModalDesc, ModalActions } from "../src/components/primitives/modal";
import { ProgressTrack } from "../src/components/primitives/progress-track";
import { Timestamp } from "../src/components/primitives/timestamp";

describe("composed primitive render contracts", () => {
  test("PageHeader preserves both branches' heading id and CSS slots", () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Heading" titleId="heading" titleClassName="custom-title"
        description="Description" descriptionClassName="custom-description"
        actions={<button type="button">Action</button>} actionsClassName="custom-actions"
        className="workspace-head"
      />,
    );
    expect(html).toContain('class="page-head workspace-head"');
    expect(html).toContain('<h2 id="heading" class="custom-title">Heading</h2>');
    expect(html).toContain('<p class="custom-description">Description</p>');
    expect(html).toContain('<div class="custom-actions"><button');
    expect(renderToStaticMarkup(<PageSubtitle>Subtitle</PageSubtitle>))
      .toBe('<p class="page-sub">Subtitle</p>');
  });

  test("tabs preserve selection, focus order, and panel relationships", () => {
    const html = renderToStaticMarkup(
      <>
        <PageTabs label="Workspace">
          <PageTab id="first" controls="first-panel" selected onClick={() => {}}>First</PageTab>
          <PageTab id="second" controls="second-panel" selected={false} onClick={() => {}}>Second</PageTab>
        </PageTabs>
        <PageTabPanel id="first-panel" labelledBy="first" tabIndex={0}>Visible</PageTabPanel>
        <PageTabPanel id="second-panel" labelledBy="second" hidden>Hidden</PageTabPanel>
      </>,
    );
    expect(html).toContain('role="tablist" aria-label="Workspace"');
    expect(html).toContain('aria-selected="true" aria-controls="first-panel" tabindex="0"');
    expect(html).toContain('aria-selected="false" aria-controls="second-panel" tabindex="-1"');
    expect(html).toContain('tabindex="0" role="tabpanel" id="first-panel" aria-labelledby="first"');
    expect(html).toContain('tabindex="0" role="tabpanel" id="second-panel" aria-labelledby="second" hidden=""');
  });

  test("div modal defaults survive undefined props and preserve explicit opt-out", () => {
    expect(renderToStaticMarkup(<Modal aria-modal={undefined} />)).toContain('aria-modal="true"');
    expect(renderToStaticMarkup(<Modal aria-modal={false} />)).toContain('aria-modal="false"');
    expect(renderToStaticMarkup(<Modal role="alertdialog" />)).toContain('role="alertdialog"');
  });

  test("native modal composition keeps dialog semantics and accessible text wiring", () => {
    const html = renderToStaticMarkup(
      <ModalDialog open aria-labelledby="dialog-title" aria-describedby="dialog-description">
        <ModalCard>
          <ModalHead titleId="dialog-title" title="Confirm" />
          <ModalDesc id="dialog-description">Description</ModalDesc>
          <ModalActions><button type="button">Cancel</button></ModalActions>
        </ModalCard>
      </ModalDialog>,
    );
    expect(html).toContain('<dialog class="modal-overlay" open=""');
    expect(html).toContain('aria-labelledby="dialog-title" aria-describedby="dialog-description"');
    expect(html).toContain('<h3 id="dialog-title">Confirm</h3>');
    expect(html).toContain('<p class="modal-desc" id="dialog-description">Description</p>');
    expect(html).toContain('class="modal-actions"');
  });

  test.each([
    [25, 100, 25, 100, "25%"],
    [-1, 100, 0, 100, "0%"],
    [101, 100, 100, 100, "100%"],
    [10, 20, 10, 20, "50%"],
    [Number.NaN, 100, 0, 100, "0%"],
    [Number.POSITIVE_INFINITY, 100, 0, 100, "0%"],
    [25, 0, 25, 100, "25%"],
    [25, Number.NaN, 25, 100, "25%"],
  ])("progress %s/%s clamps visual and accessible values together", (value, max, now, safeMax, width) => {
    const html = renderToStaticMarkup(<ProgressTrack value={Number(value)} max={Number(max)} label="Usage" />);
    expect(html).toContain('role="progressbar" aria-label="Usage"');
    expect(html).toContain(`aria-valuemax="${safeMax}" aria-valuenow="${now}"`);
    expect(html).toContain(`style="width:${width}"`);
  });

  test("decorative progress does not expose an unnamed progressbar", () => {
    const html = renderToStaticMarkup(<ProgressTrack value={25} />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('role="progressbar"');
  });

  test("timestamp emits machine-readable ISO and localized display", () => {
    const value = Date.UTC(2026, 0, 2, 12, 34, 56);
    const html = renderToStaticMarkup(<Timestamp value={value} locale="en" options={{ timeZone: "UTC", hour12: false }} />);
    expect(html).toContain('dateTime="2026-01-02T12:34:56.000Z"');
    expect(html).toContain("12:34:56");
  });

  test("timestamp renders date and time together when date fields are requested", () => {
    const value = Date.UTC(2026, 0, 2, 12, 34, 56);
    const html = renderToStaticMarkup(
      <Timestamp
        value={value}
        locale="en"
        options={{ timeZone: "UTC", hour12: false, dateStyle: "medium", timeStyle: "short" }}
      />,
    );
    expect(html).toContain('dateTime="2026-01-02T12:34:56.000Z"');
    expect(html).toContain("Jan 2, 2026");
    expect(html).toContain("12:34");
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, new Date(Number.NaN)])(
    "invalid timestamp %s cannot crash the dashboard or traffic page",
    value => {
      const html = renderToStaticMarkup(<Timestamp value={value} locale="en" />);
      expect(html).toContain("<time>");
      expect(html).not.toContain("dateTime=");
    },
  );
});
