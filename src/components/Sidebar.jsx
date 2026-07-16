import React, { useContext, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { AuthContext } from "../contexts/AuthContext.jsx";
import { useTheme } from "../contexts/ThemeContext.jsx";
import {
  LayoutDashboard,
  Table,
  Building2,
  CreditCard,
  Users,
  PieChart,
  Clock3,
  FileText,
  ShieldCheck,
  LogOut,
  ChevronLeft,
  Landmark,
  Building,
  Sun,
  Moon,
  Send,
  Phone,
  KeyRound,
  FolderCheck,
  UserMinus,
  Archive,
} from "lucide-react";

const SidebarContent = ({
  isCollapsed,
  setIsMobileMenuOpen,
  compactMode = false,
  workloadAlarmActive = false,
  pendingWorkloadCount = 0,
  workloadThreshold = 12,
  onRequestReplacementHelp = () => {},
  replacementRequestState = {},
}) => {
  const { currentUser, logout } = useContext(AuthContext);
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    { view: "kanban", icon: LayoutDashboard, label: "Kanban" },
    { view: "table", icon: Table, label: "Depósitos" },
    { view: "sucursales", icon: Building2, label: "Sucursales" },
    { view: "bancos", icon: CreditCard, label: "Cuentas" },
    { view: "gestion-bancos", icon: Landmark, label: "Bancos" },
    { view: "gestion-empresas", icon: Building, label: "Empresas" },
    { view: "usuarios", icon: Users, label: "Usuarios", adminOnly: true },
    {
      view: "configuracion-ycloud",
      icon: Phone,
      label: "Config YCloud",
      adminOnly: true,
    },
    {
      view: "enviar-mensaje-ycloud",
      icon: Send,
      label: "Enviar YCloud",
      adminOnly: true,
    },
    { view: "reportes", icon: PieChart, label: "Reportes" },
    { view: "confirmados", icon: Clock3, label: "Confirmados" },
    { view: "documentos", icon: FileText, label: "Documentos" },
    { view: "exportar-vouchers", icon: Archive, label: "Exportar Vouchers" },
    { view: "regularizar-depositos", icon: FolderCheck, label: "Regularizar Depósitos" },
    { view: "cambiar-contrasena", icon: KeyRound, label: "Cambiar Contraseña" },
  ];

  const visibleMenuItems = menuItems.filter(
    (item) =>
      !item.adminOnly || (item.adminOnly && currentUser?.user_rol === "admin")
  );

  const handleItemClick = (view) => {
    navigate(`/${view}`);
    if (setIsMobileMenuOpen) {
      setIsMobileMenuOpen(false);
    }
  };

  const handleRequestReplacement = async () => {
    const reason = window.prompt(
      "Indica el motivo de la ausencia o el tipo de apoyo que necesitas:",
      "Necesito Apoyo!!"
    );

    if (reason === null) {
      return;
    }

    try {
      await onRequestReplacementHelp({ reason });
    } catch (error) {
      window.alert(error.message || "No se pudo solicitar el reemplazo.");
    }
  };

  return (
    <div
      className={`flex flex-col h-full bg-white border-r border-gray-200 dark:bg-gray-900 dark:border-gray-800 ${
        compactMode ? "text-[0.95rem]" : ""
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center p-4 border-b border-gray-200 dark:border-gray-800 ${
          isCollapsed ? "justify-center" : "justify-between"
        }`}
      >
        <div className="flex items-center space-x-3">
          <div className="bg-blue-600 p-2 rounded-lg flex-shrink-0">
            <ShieldCheck className="text-white" size={17} />
          </div>
          {!isCollapsed && (
            <div className="overflow-hidden">
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">
                Control Depósitos
              </h1>
              <p className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                GRUPO JCH
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Navegación */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        <ul>
          {visibleMenuItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname === `/${item.view}` || (item.view === "kanban" && location.pathname === "/");

            return (
              <li key={item.view}>
                <button
                  onClick={() => handleItemClick(item.view)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 flex items-center space-x-3 ${
                    isCollapsed ? "justify-center" : ""
                  } ${
                    isActive
                      ? "bg-blue-600 text-white shadow-sm"
                      : "hover:bg-gray-100 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                  }`}
                  title={isCollapsed ? item.label : undefined}
                >
                  <Icon size={14} />
                  {!isCollapsed && (
                    <span
                      className={`font-medium ${
                        isActive ? "font-semibold" : ""
                      }`}
                    >
                      {item.label}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div
        className={`p-4 border-t border-gray-200 dark:border-gray-800 ${
          isCollapsed ? "p-2" : "p-4"
        }`}
      >
        <button
          onClick={handleRequestReplacement}
          disabled={replacementRequestState?.isSending}
          className={`mb-3 w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200 dark:hover:bg-red-950/50 ${isCollapsed ? "justify-center" : ""}`}
          title="Pedir apoyo"
        >
          <span className={`flex items-center ${isCollapsed ? "justify-center" : "gap-2"}`}>
            <UserMinus size={14} />
            {!isCollapsed && (
              <span>{replacementRequestState?.isSending ? "Enviando..." : "Necesito Apoyo!!"}</span>
            )}
          </span>
        </button>

        <div className={`p-2 ${isCollapsed ? "mb-2" : ""}`}>
          <button
            onClick={toggleTheme}
            className={`w-full flex items-center p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 ${
              isCollapsed ? "justify-center" : ""
            }`}
            title={
              isCollapsed
                ? theme === "light"
                  ? "Modo Oscuro"
                  : "Modo Claro"
                : ""
            }
          >
            {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
            {!isCollapsed && (
              <span className="ml-3 text-sm font-medium">
                {theme === "light" ? "Modo Oscuro" : "Modo Claro"}
              </span>
            )}
          </button>
        </div>
        <div
          className={`flex items-center rounded-lg bg-gray-50 dark:bg-gray-800/50 ${
            isCollapsed ? "justify-center p-2" : "justify-between p-2"
          }`}
        >
          {!isCollapsed && (
            <div className="flex items-center space-x-3 overflow-hidden">
              <div className="h-10 w-10 rounded-full bg-blue-200 dark:bg-blue-900/50 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold flex-shrink-0">
                {String(currentUser?.nombre || "UD")
                  .split(" ")
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join("")
                  .toUpperCase()}
              </div>
              <div className="overflow-hidden">
                <p className="font-semibold text-sm text-gray-800 dark:text-gray-200 whitespace-nowrap">
                  {currentUser?.nombre || "Usuario"}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap capitalize">
                  {currentUser?.user_rol}
                </p>
              </div>
            </div>
          )}
          {isCollapsed && (
            <div className="flex flex-col items-center space-y-2">
              <div className="h-10 w-10 rounded-full bg-blue-200 dark:bg-blue-900/50 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold">
                {String(currentUser?.nombre || "UD")
                  .split(" ")
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join("")
                  .toUpperCase()}
              </div>
              <button
                onClick={() => {
                  console.log("🔄 Botón logout (colapsado) clickeado");
                  if (logout && typeof logout === "function") {
                    logout();
                  } else {
                    console.error("❌ Función logout no disponible");
                  }
                }}
                className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/50 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                aria-label="Cerrar sesión"
                title="Cerrar sesión"
              >
                <LogOut
                  size={10}
                  className="text-gray-600 dark:text-gray-400"
                />
              </button>
            </div>
          )}
          {!isCollapsed && (
            <button
              onClick={() => {
                console.log("🔄 Botón logout clickeado");
                if (logout && typeof logout === "function") {
                  logout();
                } else {
                  console.error("❌ Función logout no disponible");
                }
              }}
              className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/50 hover:text-red-600 dark:hover:text-red-400 flex-shrink-0 transition-colors"
              aria-label="Cerrar sesión"
              title="Cerrar sesión"
            >
              <LogOut size={12} className="text-gray-600 dark:text-gray-400" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const Sidebar = ({
  isSidebarCollapsed,
  setIsSidebarCollapsed,
  isMobileMenuOpen,
  setIsMobileMenuOpen,
  compactMode = false,
  workloadAlarmActive = false,
  pendingWorkloadCount = 0,
  workloadThreshold = 12,
  onRequestReplacementHelp = () => {},
  replacementRequestState = {},
}) => {
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "auto";
    }
    return () => {
      document.body.style.overflow = "auto";
    };
  }, [isMobileMenuOpen]);

  return (
    <>
      {/* Desktop Sidebar */}
      <div
        className={`hidden lg:flex lg:flex-shrink-0 relative transition-all duration-300 ease-in-out ${
          isSidebarCollapsed ? "w-20" : "w-72"
        }`}
      >
        <SidebarContent
          isCollapsed={isSidebarCollapsed}
          compactMode={compactMode}
          workloadAlarmActive={workloadAlarmActive}
          pendingWorkloadCount={pendingWorkloadCount}
          workloadThreshold={workloadThreshold}
          onRequestReplacementHelp={onRequestReplacementHelp}
          replacementRequestState={replacementRequestState}
        />
        <button
          onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          className="hidden lg:block absolute top-1/2 -right-3 transform -translate-y-1/2 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 rounded-full p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 z-10"
          aria-label={isSidebarCollapsed ? "Expandir menú" : "Colapsar menú"}
        >
          <ChevronLeft
            size={12}
            className={`transition-transform duration-300 ${
              isSidebarCollapsed ? "rotate-180" : "rotate-0"
            }`}
          />
        </button>
      </div>

      {/* Mobile Sidebar */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="fixed inset-0 bg-black/50 z-30 lg:hidden"
              onClick={() => setIsMobileMenuOpen(false)}
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="fixed top-0 left-0 bottom-0 w-72 z-40 lg:hidden"
            >
              <SidebarContent
                isCollapsed={false}
                setIsMobileMenuOpen={setIsMobileMenuOpen}
                compactMode={compactMode}
                workloadAlarmActive={workloadAlarmActive}
                pendingWorkloadCount={pendingWorkloadCount}
                workloadThreshold={workloadThreshold}
                onRequestReplacementHelp={onRequestReplacementHelp}
                replacementRequestState={replacementRequestState}
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
};

export default Sidebar;
