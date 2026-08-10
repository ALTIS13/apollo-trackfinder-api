import { Users } from "lucide-react";

import type { AccountSummary, DashboardAccount } from "../types/dashboard";

const statusLabels: Record<DashboardAccount["status"], string> = {
  pending: "Ожидает",
  active: "Активен",
  suspended: "Приостановлен",
  deleted: "Удален",
};

const connectionLabels = {
  connected: "Подключен",
  disconnected: "Не подключен",
  unavailable: "Недоступно",
} as const;

const activityFormatter = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Moscow",
});

interface AccountsTableProps {
  summary: AccountSummary;
  accounts: DashboardAccount[];
}

function ConnectionCell({
  connection,
}: {
  readonly connection: DashboardAccount["spotify"];
}) {
  return (
    <span className="status-cell" data-status={connection.state === "connected" ? "healthy" : connection.state === "unavailable" ? "unknown" : "warning"}>
      {connectionLabels[connection.state]}
      {connection.displayName === undefined ? null : <small>{connection.displayName}</small>}
    </span>
  );
}

export function AccountsTable({ summary, accounts }: AccountsTableProps) {
  return (
    <section className="data-panel accounts-panel" id="accounts" aria-labelledby="accounts-title">
      <div className="data-panel-header">
        <span className="panel-title-icon parser" aria-hidden="true"><Users /></span>
        <div>
          <h2 id="accounts-title">Пользователи</h2>
          <p>{summary.total} всего, {summary.activeNow} активны сейчас, {summary.pending} ожидают, {summary.suspended} приостановлены</p>
        </div>
      </div>
      <div className="table-scroll">
        <table aria-label="Пользователи">
          <thead>
            <tr>
              <th scope="col">Аккаунт</th>
              <th scope="col">Статус</th>
              <th scope="col">Активность</th>
              <th scope="col">Сессии</th>
              <th scope="col">Модули</th>
              <th scope="col">Spotify</th>
              <th scope="col">Яндекс</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <th scope="row"><strong>{account.displayName}</strong><small>{account.email}</small></th>
                <td><span className="status-cell" data-status={account.status === "active" ? "healthy" : account.status === "suspended" ? "degraded" : "warning"}>{statusLabels[account.status]}</span></td>
                <td>{account.latestActivityAt === undefined ? <span className="table-empty-value">Нет данных</span> : <time dateTime={account.latestActivityAt}>{activityFormatter.format(new Date(account.latestActivityAt))}</time>}</td>
                <td>{account.activeSessionCount}</td>
                <td>{account.moduleKeys.length === 0 ? <span className="table-empty-value">Нет доступа</span> : account.moduleKeys.join(", ")}</td>
                <td><ConnectionCell connection={account.spotify} /></td>
                <td><ConnectionCell connection={account.yandex} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
