import { PackageCheck, PackageOpen } from "lucide-react";
import type { HealthStatus, ServiceModule } from "../types/dashboard";

const healthLabels: Record<HealthStatus, string> = {
  healthy: "Работает",
  warning: "Предупреждение",
  degraded: "Деградация",
  unknown: "Нет данных",
};
const deploymentFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Moscow",
});

interface DeploymentsTableProps {
  modules: ServiceModule[];
}

export function DeploymentsTable({ modules }: DeploymentsTableProps) {
  return (
    <section className="data-panel deployments-panel" id="deployments" aria-labelledby="deployments-title">
      <div className="data-panel-header">
        <span className="panel-title-icon" aria-hidden="true"><PackageOpen /></span>
        <div>
          <h2 id="deployments-title">Деплойменты</h2>
          <p>Текущие и доступные версии</p>
        </div>
      </div>
      <div className="table-scroll">
        <table aria-label="Деплойменты сервисов">
          <thead>
            <tr>
              <th scope="col">Сервис</th>
              <th scope="col">Текущая</th>
              <th scope="col">Доступна</th>
              <th scope="col">Состояние</th>
              <th scope="col">Последний деплой</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((module) => {
              const hasUpdate =
                module.availableVersion !== undefined &&
                module.availableVersion !== module.version;
              return (
                <tr key={module.id}>
                  <th scope="row">
                    <span className="table-service">
                      <PackageCheck aria-hidden="true" />
                      <span><strong>{module.name}</strong><small>{module.id}</small></span>
                    </span>
                  </th>
                  <td><code>{module.version}</code></td>
                  <td>
                    <code className={hasUpdate ? "available-version" : undefined}>
                      {module.availableVersion ?? module.version}
                    </code>
                  </td>
                  <td>
                    <span className="status-cell" data-status={hasUpdate ? "warning" : module.status}>
                      {hasUpdate ? "Доступно обновление" : healthLabels[module.status]}
                    </span>
                  </td>
                  <td>
                    <time dateTime={module.lastDeploymentAt}>
                      {deploymentFormatter.format(new Date(module.lastDeploymentAt))}
                    </time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
