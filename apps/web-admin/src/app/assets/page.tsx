"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Banner,
  Chip,
  Field,
  Figure,
  Form,
  Loading,
  Modal,
  Problem,
  Shell,
  Tabs,
  useAction,
} from "../../components/Shell";
import { api, can, rupees, shortDate } from "../../lib/api";

interface Asset {
  id: string;
  code: string;
  name: string;
  category: string;
  towerId: string | null;
  towerName: string | null;
  location: string | null;
  makeModel: string | null;
  serialNumber: string | null;
  purchaseDate: string | null;
  purchaseCost: string | null;
  warrantyUntil: string | null;
  expectedLifeYears: number | null;
  amcVendor: string | null;
  amcUntil: string | null;
  amcDaysLeft: number | null;
  condition: string;
  status: string;
  disposedOn: string | null;
  nextDue: string | null;
  lastServiced: string | null;
  overdue: boolean;
}

interface Work {
  id: string;
  kind: string;
  dueOn: string;
  intervalMonths: number | null;
  vendor: string | null;
  notes: string | null;
  daysLeft: number;
  overdue: boolean;
  assetId: string;
  assetCode: string;
  assetName: string;
  category: string;
  location: string | null;
}

interface Due {
  withinDays: number;
  work: Work[];
  amcExpiring: {
    id: string;
    code: string;
    name: string;
    amcVendor: string | null;
    amcUntil: string;
    daysLeft: number;
  }[];
}

interface ScheduleRow {
  id: string;
  code: string;
  name: string;
  category: string;
  purchaseDate: string | null;
  purchaseCost: string;
  expectedLifeYears: number | null;
  accumulatedDepreciation: string;
  writtenDownValue: string;
  notDepreciated: boolean;
}

interface Schedule {
  asOf: string;
  method: string;
  basis: string;
  assets: ScheduleRow[];
  byCategory: {
    category: string;
    count: number;
    cost: string;
    accumulatedDepreciation: string;
    writtenDownValue: string;
  }[];
  totals: { cost: string; accumulatedDepreciation: string; writtenDownValue: string };
  notDepreciated: number;
}

interface Categories {
  assets: { code: string; label: string }[];
  maintenance: { code: string; label: string }[];
}

interface Tower {
  id: string;
  name: string;
}

type Tab = "due" | "register" | "schedule";

/**
 * The plant: lifts, pumps, gensets, the STP, the fire system.
 *
 * What a committee loses when this lives in one facility manager's head is not the list.
 * It is knowing which lift is under AMC and until when on the morning it stops between
 * floors, that the DG service was due in March, and what the outgoing committee handed
 * over. So **what is due opens first** — a register nobody has a reason to open is a
 * register that goes stale, and the reason is the work.
 */
export default function AssetsPage() {
  const [tab, setTab] = useState<Tab>("due");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [due, setDue] = useState<Due | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [categories, setCategories] = useState<Categories | null>(null);
  const [towers, setTowers] = useState<Tower[]>([]);
  const [adding, setAdding] = useState(false);
  const [scheduling, setScheduling] = useState<Asset | null>(null);
  const [closing, setClosing] = useState<Work | null>(null);
  const [costsDenied, setCostsDenied] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const mayManage = can("society_admin", "mc_member");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [register, dueNow, cats] = await Promise.all([
        api.get<Asset[]>("/v1/assets"),
        api.get<Due>("/v1/assets/due"),
        api.get<Categories>("/v1/assets/categories"),
      ]);
      setAssets(register);
      setDue(dueNow);
      setCategories(cats);
      setError("");

      try {
        setTowers(await api.get<Tower[]>("/v1/society/towers"));
      } catch {
        setTowers([]);
      }

      /*
       * The fixed-asset schedule is narrower than the register: a technician reads the
       * register and has no business reading what the society paid. A 403 here must not
       * blank the page they came for.
       */
      try {
        setSchedule(await api.get<Schedule>("/v1/assets/schedule"));
        setCostsDenied(false);
      } catch {
        setCostsDenied(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = assets.filter((a) => a.status !== "disposed");
  const overdue = due?.work.filter((w) => w.overdue) ?? [];
  const lapsing = due?.amcExpiring ?? [];
  const label = useMemo(
    () => new Map((categories?.assets ?? []).map((c) => [c.code, c.label])),
    [categories],
  );

  return (
    <Shell
      title="Assets & Maintenance"
      lede="What the society owns, what is due on it, and what it is worth on paper."
      actions={
        mayManage ? (
          <button data-variant="primary" onClick={() => setAdding(true)}>
            Add an asset
          </button>
        ) : null
      }
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

      <dl className="figures settle">
        <Figure label="In use" value={String(live.length)} hint="excluding retired" />
        <Figure
          label="Overdue"
          value={String(overdue.length)}
          hint="work past its due date"
          {...(overdue.length > 0 ? { tone: "arrears" as const } : {})}
        />
        <Figure
          label="AMC lapsing"
          value={String(lapsing.length)}
          hint={`within ${due?.withinDays ?? 45} days`}
          {...(lapsing.length > 0 ? { tone: "arrears" as const } : {})}
        />
        {schedule ? (
          <Figure
            label="Written-down value"
            value={rupees(schedule.totals.writtenDownValue)}
            hint={`cost ${rupees(schedule.totals.cost)}`}
          />
        ) : null}
      </dl>

      <section className="ledger settle">
        <Tabs
          tabs={[
            { id: "due" as const, label: "What is due" },
            { id: "register" as const, label: "The register" },
            { id: "schedule" as const, label: "Fixed assets" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "due" ? (
          <>
            {lapsing.length > 0 ? (
              <Banner tone="warn">
                {lapsing.length} AMC{lapsing.length === 1 ? "" : "s"} lapse within{" "}
                {due?.withinDays} days. A contract that expired last month is worse than
                none, because everyone believes there is cover.
              </Banner>
            ) : null}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Due</th>
                    <th>Asset</th>
                    <th>Work</th>
                    <th>Vendor</th>
                    <th>Where</th>
                    {mayManage ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {(due?.work ?? []).map((work) => (
                    <tr key={work.id}>
                      <td>
                        {work.overdue ? (
                          <Chip tone="arrears">{shortDate(work.dueOn)}</Chip>
                        ) : (
                          <span className="muted">{shortDate(work.dueOn)}</span>
                        )}
                        <span className="sub">
                          {work.overdue
                            ? `${Math.abs(work.daysLeft)} days late`
                            : `in ${work.daysLeft} days`}
                        </span>
                      </td>
                      <td className="strong">
                        {work.assetName}
                        <span className="sub">{work.assetCode}</span>
                      </td>
                      <td>
                        <Chip tone={work.kind === "statutory" ? "brand" : "quiet"}>
                          {work.kind.replace(/_/g, " ")}
                        </Chip>
                        {work.intervalMonths ? (
                          <span className="sub">every {work.intervalMonths} months</span>
                        ) : null}
                      </td>
                      <td className="muted">{work.vendor ?? "—"}</td>
                      <td className="muted">{work.location ?? "—"}</td>
                      {mayManage ? (
                        <td>
                          <button onClick={() => setClosing(work)}>Record it done</button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                  {(due?.amcExpiring ?? []).map((amc) => (
                    <tr key={`amc-${amc.id}`}>
                      <td>
                        <Chip tone={amc.daysLeft < 0 ? "arrears" : "pending"}>
                          {shortDate(amc.amcUntil)}
                        </Chip>
                        <span className="sub">
                          {amc.daysLeft < 0
                            ? `expired ${Math.abs(amc.daysLeft)} days ago`
                            : `in ${amc.daysLeft} days`}
                        </span>
                      </td>
                      <td className="strong">
                        {amc.name}
                        <span className="sub">{amc.code}</span>
                      </td>
                      <td>
                        <Chip tone="brand">AMC expiry</Chip>
                      </td>
                      <td className="muted">{amc.amcVendor ?? "—"}</td>
                      <td className="muted">—</td>
                      {mayManage ? <td /> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loading && (due?.work.length ?? 0) === 0 && lapsing.length === 0 ? (
              <div style={{ padding: 17 }}>
                <Banner tone="info">
                  Nothing is due in the next {due?.withinDays ?? 45} days and no contract is
                  about to lapse.
                </Banner>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "register" ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Asset</th>
                  <th>Where</th>
                  <th>Condition</th>
                  <th>AMC</th>
                  <th>Last serviced</th>
                  {mayManage ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td className="strong">{asset.code}</td>
                    <td>
                      {asset.name}
                      <span className="sub">
                        {label.get(asset.category) ?? asset.category}
                        {asset.makeModel ? ` · ${asset.makeModel}` : ""}
                      </span>
                    </td>
                    <td className="muted">
                      {asset.location ?? asset.towerName ?? "—"}
                    </td>
                    <td>
                      {asset.status === "disposed" ? (
                        <Chip tone="quiet">retired {shortDate(asset.disposedOn ?? "")}</Chip>
                      ) : asset.condition === "good" ? (
                        <Chip tone="settled">good</Chip>
                      ) : (
                        <Chip tone={asset.condition === "fair" ? "pending" : "arrears"}>
                          {asset.condition.replace(/_/g, " ")}
                        </Chip>
                      )}
                    </td>
                    <td>
                      {asset.amcUntil ? (
                        <>
                          {asset.amcDaysLeft !== null && asset.amcDaysLeft < 60 ? (
                            <Chip tone="arrears">{shortDate(asset.amcUntil)}</Chip>
                          ) : (
                            <span className="muted">{shortDate(asset.amcUntil)}</span>
                          )}
                          <span className="sub">{asset.amcVendor ?? "—"}</span>
                        </>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td className="muted">
                      {asset.lastServiced ? shortDate(asset.lastServiced) : "never"}
                      {asset.overdue ? <span className="sub">work overdue</span> : null}
                    </td>
                    {mayManage ? (
                      <td>
                        {asset.status === "disposed" ? null : (
                          <button onClick={() => setScheduling(asset)}>Schedule work</button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "schedule" ? (
          costsDenied ? (
            <div style={{ padding: 17 }}>
              <Banner tone="info">
                The fixed-asset schedule is committee and auditor work. The register itself
                is open to you — what the society paid for each item is not.
              </Banner>
            </div>
          ) : schedule ? (
            <>
              <div style={{ padding: "17px 17px 0" }}>
                {/* Said on the page as well as on the payload. This figure gets read next
                    to an auditor's own schedule, and somebody has to say they may differ. */}
                <Banner tone="info">{schedule.basis}</Banner>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th className="num">Items</th>
                      <th className="num">Cost</th>
                      <th className="num">Depreciation</th>
                      <th className="num">Written down</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schedule.byCategory.map((row) => (
                      <tr key={row.category}>
                        <td className="strong">{label.get(row.category) ?? row.category}</td>
                        <td className="num muted">{row.count}</td>
                        <td className="num">{rupees(row.cost)}</td>
                        <td className="num muted">{rupees(row.accumulatedDepreciation)}</td>
                        <td className="num">{rupees(row.writtenDownValue)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="strong">Total</td>
                      <td className="num muted">{schedule.assets.length}</td>
                      <td className="num strong">{rupees(schedule.totals.cost)}</td>
                      <td className="num muted">
                        {rupees(schedule.totals.accumulatedDepreciation)}
                      </td>
                      <td className="num strong">{rupees(schedule.totals.writtenDownValue)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {schedule.notDepreciated > 0 ? (
                <div style={{ padding: 17 }}>
                  <Banner tone="warn">
                    {schedule.notDepreciated} item
                    {schedule.notDepreciated === 1 ? " is" : "s are"} carried at cost because
                    no expected life or purchase date is recorded. Counted separately rather
                    than rolled into the total, so the omission is visible.
                  </Banner>
                </div>
              ) : null}
            </>
          ) : null
        ) : null}
      </section>

      {adding && categories ? (
        <AddAsset
          categories={categories}
          towers={towers}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      ) : null}

      {scheduling && categories ? (
        <ScheduleWork
          asset={scheduling}
          kinds={categories.maintenance}
          onClose={() => setScheduling(null)}
          onDone={() => {
            setScheduling(null);
            void load();
          }}
        />
      ) : null}

      {closing ? (
        <CloseWork
          work={closing}
          onClose={() => setClosing(null)}
          onDone={() => {
            setClosing(null);
            void load();
          }}
        />
      ) : null}
    </Shell>
  );
}

function AddAsset({
  categories,
  towers,
  onClose,
  onDone,
}: {
  categories: Categories;
  towers: Tower[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [form, setForm] = useState({
    code: "",
    name: "",
    category: categories.assets[0]?.code ?? "other",
    towerId: "",
    location: "",
    makeModel: "",
    serialNumber: "",
    purchaseDate: "",
    purchaseCost: "",
    supplier: "",
    expectedLifeYears: "",
    amcVendor: "",
    amcUntil: "",
  });

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const costOk = !form.purchaseCost || /^\d+(\.\d{1,4})?$/.test(form.purchaseCost);
  const lifeOk = !form.expectedLifeYears || /^\d{1,2}$/.test(form.expectedLifeYears);
  const ready = Boolean(form.code && form.name) && costOk && lifeOk;

  return (
    <Modal
      title="Add an asset"
      note="The tag is the one physically stuck on the machine. Two assets with the same tag is the confusion this register prevents."
      onClose={onClose}
      wide
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            data-variant="primary"
            disabled={!ready || action.busy}
            onClick={() =>
              void action.run(
                () =>
                  api.post("/v1/assets", {
                    code: form.code,
                    name: form.name,
                    category: form.category,
                    ...(form.towerId ? { towerId: form.towerId } : {}),
                    ...(form.location ? { location: form.location } : {}),
                    ...(form.makeModel ? { makeModel: form.makeModel } : {}),
                    ...(form.serialNumber ? { serialNumber: form.serialNumber } : {}),
                    ...(form.purchaseDate ? { purchaseDate: form.purchaseDate } : {}),
                    ...(form.purchaseCost ? { purchaseCost: form.purchaseCost } : {}),
                    ...(form.supplier ? { supplier: form.supplier } : {}),
                    ...(form.expectedLifeYears
                      ? { expectedLifeYears: Number(form.expectedLifeYears) }
                      : {}),
                    ...(form.amcVendor ? { amcVendor: form.amcVendor } : {}),
                    ...(form.amcUntil ? { amcUntil: form.amcUntil } : {}),
                  }),
                { onDone },
              )
            }
          >
            Add it
          </button>
        </>
      }
    >
      {action.error ? <Problem error={action.error} /> : null}
      <Form onSubmit={() => undefined}>
        <Field label="Tag" hint="LIFT-A-01">
          <input value={form.code} onChange={(e) => set("code")(e.target.value)} />
        </Field>
        <Field label="Name">
          <input value={form.name} onChange={(e) => set("name")(e.target.value)} />
        </Field>
        <Field label="Category">
          <select value={form.category} onChange={(e) => set("category")(e.target.value)}>
            {categories.assets.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tower" hint="optional">
          <select value={form.towerId} onChange={(e) => set("towerId")(e.target.value)}>
            <option value="">Not tower-specific</option>
            {towers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Where it is" hint="basement 2, near the ramp">
          <input value={form.location} onChange={(e) => set("location")(e.target.value)} />
        </Field>
        <Field label="Make and model" hint="optional">
          <input value={form.makeModel} onChange={(e) => set("makeModel")(e.target.value)} />
        </Field>
        <Field label="Serial number" hint="optional">
          <input
            value={form.serialNumber}
            onChange={(e) => set("serialNumber")(e.target.value)}
          />
        </Field>
        <Field label="Purchased on" hint="optional">
          <input
            type="date"
            value={form.purchaseDate}
            onChange={(e) => set("purchaseDate")(e.target.value)}
          />
        </Field>
        <Field label="Cost" hint="optional — used for the fixed-asset schedule">
          <input
            value={form.purchaseCost}
            inputMode="decimal"
            placeholder="0.00"
            onChange={(e) => set("purchaseCost")(e.target.value)}
          />
        </Field>
        <Field label="Expected life" hint="years — no life means it is carried at cost">
          <input
            value={form.expectedLifeYears}
            inputMode="numeric"
            onChange={(e) => set("expectedLifeYears")(e.target.value)}
          />
        </Field>
        <Field label="AMC vendor" hint="optional">
          <input value={form.amcVendor} onChange={(e) => set("amcVendor")(e.target.value)} />
        </Field>
        <Field label="AMC until" hint="optional — the console counts down against this">
          <input
            type="date"
            value={form.amcUntil}
            onChange={(e) => set("amcUntil")(e.target.value)}
          />
        </Field>
      </Form>
      {!costOk ? <Banner tone="warn">Cost is a plain decimal, like 180000.00.</Banner> : null}
    </Modal>
  );
}

function ScheduleWork({
  asset,
  kinds,
  onClose,
  onDone,
}: {
  asset: Asset;
  kinds: { code: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [kind, setKind] = useState(kinds[0]?.code ?? "service");
  const [dueOn, setDueOn] = useState(new Date().toISOString().slice(0, 10));
  const [interval, setInterval] = useState("");
  const [vendor, setVendor] = useState(asset.amcVendor ?? "");
  const [notes, setNotes] = useState("");

  const submit = () =>
    void action.run(
      () =>
        api.post(`/v1/assets/${asset.id}/work`, {
          kind,
          dueOn,
          ...(interval ? { intervalMonths: Number(interval) } : {}),
          ...(vendor ? { vendor } : {}),
          ...(notes ? { notes } : {}),
        }),
      { onDone },
    );

  return (
    <Modal
      title={`Schedule work on ${asset.name}`}
      note="Set an interval and completing this job schedules the next one automatically."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button data-variant="primary" disabled={!dueOn || action.busy} onClick={submit}>
            Schedule it
          </button>
        </>
      }
    >
      {action.error ? <Problem error={action.error} /> : null}
      <Form onSubmit={submit}>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.code} value={k.code}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due on">
          <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
        </Field>
        <Field label="Repeat every" hint="months — leave blank for a one-off">
          <input
            value={interval}
            inputMode="numeric"
            onChange={(e) => setInterval(e.target.value)}
          />
        </Field>
        <Field label="Vendor" hint="optional">
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </Field>
        <Field label="Notes" hint="optional">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  );
}

/**
 * Close a job.
 *
 * Warned about plainly, because it is true: once written this entry cannot be re-dated or
 * restated. It is what a society produces when a lift injures somebody and the question is
 * whether it was serviced, and a log that can be tidied up afterwards proves nothing.
 */
function CloseWork({
  work,
  onClose,
  onDone,
}: {
  work: Work;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction();
  const [completedOn, setCompletedOn] = useState(new Date().toISOString().slice(0, 10));
  const [vendor, setVendor] = useState(work.vendor ?? "");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");

  const costOk = !cost || /^\d+(\.\d{1,4})?$/.test(cost);
  const submit = () =>
    void action.run(
      () =>
        api.post(`/v1/assets/work/${work.id}/complete`, {
          completedOn,
          ...(vendor ? { vendor } : {}),
          ...(cost ? { cost } : {}),
          ...(notes ? { notes } : {}),
        }),
      { onDone },
    );

  return (
    <Modal
      title={`Record ${work.kind.replace(/_/g, " ")} on ${work.assetName}`}
      note="Final once saved. Correcting a mistake means recording another entry."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button
            data-variant="primary"
            disabled={!completedOn || !costOk || action.busy}
            onClick={submit}
          >
            Record it done
          </button>
        </>
      }
    >
      {action.error ? <Problem error={action.error} /> : null}
      {work.intervalMonths ? (
        <Banner tone="info">
          The next {work.kind.replace(/_/g, " ")} will be scheduled for{" "}
          {work.intervalMonths} months after this one was <em>due</em> — not after today, so
          a job done late does not push every future one late with it.
        </Banner>
      ) : null}
      <Form onSubmit={submit}>
        <Field label="Completed on">
          <input
            type="date"
            value={completedOn}
            onChange={(e) => setCompletedOn(e.target.value)}
          />
        </Field>
        <Field label="Vendor" hint="optional">
          <input value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </Field>
        <Field label="Cost" hint="optional">
          <input
            value={cost}
            inputMode="decimal"
            placeholder="0.00"
            onChange={(e) => setCost(e.target.value)}
          />
        </Field>
        <Field label="What was done" hint="optional, and the one field worth filling in">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </Form>
    </Modal>
  );
}
