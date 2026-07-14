import {
  AudioLines,
  Gauge,
  Network,
  RadioTower,
  Rocket,
  TriangleAlert,
} from "lucide-react";

interface AdminSidebarProps {
  openIncidentCount: number;
}

const navigationItems = [
  { href: "#summary", label: "Сводка", icon: Gauge },
  { href: "#topology", label: "Топология", icon: Network },
  { href: "#incidents", label: "Инциденты", icon: TriangleAlert },
  { href: "#deployments", label: "Деплойменты", icon: Rocket },
  { href: "#providers", label: "Провайдеры", icon: RadioTower },
] as const;

export function AdminSidebar({ openIncidentCount }: AdminSidebarProps) {
  return (
    <aside className="admin-sidebar">
      <a className="brand-lockup" href="#summary" aria-label="Apollo TF, к сводке">
        <span className="brand-mark" aria-hidden="true">
          <AudioLines />
        </span>
        <span>
          <strong>Apollo TF</strong>
          <small>Admin topology</small>
        </span>
      </a>

      <nav aria-label="Разделы панели">
        {navigationItems.map(({ href, label, icon: Icon }, index) => (
          <a
            aria-label={label}
            className={index === 1 ? "is-active" : undefined}
            href={href}
            key={href}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
            {label === "Инциденты" && openIncidentCount > 0 ? (
              <span className="nav-count" aria-hidden="true">
                {openIncidentCount}
              </span>
            ) : null}
          </a>
        ))}
      </nav>

      <div className="sidebar-user">
        <span className="user-avatar" aria-hidden="true">A</span>
        <span>
          <strong>admin</strong>
          <small>Администратор</small>
        </span>
      </div>
    </aside>
  );
}
