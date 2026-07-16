import React, {
  useState,
  useMemo,
  useContext,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import DepositCard from "./DepositCard";
import DepositDetailModal from "./DepositDetailModal";
import ContactosModal from "./ContactosModal";
import DailyAttendanceSummary from "./DailyAttendanceSummary";
import {
  Search,
  ChevronRight,
  ChevronDown,
  Calendar,
  MessageCircle,
  ToggleLeft,
  ToggleRight,
  X,
} from "lucide-react";
import { AuthContext } from "../contexts/AuthContext.jsx";
import { toLocalISOString } from "../utils/dateFormatters";
import ConnectionIndicator from "./ConnectionIndicator";
import {
  saveOpenDepositId,
  clearOpenDepositId,
  restoreOpenDeposit,
  PERSISTENCE_CONFIG,
} from "../utils/persistenceHelpers";

const ColumnContent = ({ deposits, onCardClick, selectedDepositId }) => {
  if (!deposits || deposits.length === 0) {
    return (
      <div className="text-center text-gray-500 dark:text-gray-400 py-8 px-4">
        <p className="text-sm">No hay depósitos en este estado.</p>
      </div>
    );
  }
  return (
    <AnimatePresence>
      {deposits.map((deposit) => (
        <motion.div
          key={deposit.id}
          layout
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.2 }}
        >
          <DepositCard
            deposit={deposit}
            onClick={() => onCardClick(deposit)}
            isSelected={selectedDepositId === deposit.id}
          />
        </motion.div>
      ))}
    </AnimatePresence>
  );
};

const normalizeAmountInput = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const cleaned = raw.replace(/[^\d,.-]/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = cleaned.replace(/,/g, "");
  }

  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? null : parsed;
};

const KanbanView = ({
  deposits,
  onUpdateDeposit,
  onTakeDeposit,
  onFetchDepositsByDate,
  onFetchAllDeposits,
  onSelectedDateChange,
  onSelectDate,
  empresas,
  bancos,
  cuentas,
  onOpenVoucherWindow,
  connectionStatus,
  showConnectionStatus = true,
  realtimeActivity,
  workloadAlarmActive = false,
  pendingWorkloadCount = 0,
  workloadThreshold = 12,
  onRequestReplacementHelp = () => {},
  replacementRequestState = {},
  detailPresentationMode = "default",
}) => {
  const { currentUser, users } = useContext(AuthContext);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [amountSearch, setAmountSearch] = useState("");
  const [branchPersonSearch, setBranchPersonSearch] = useState("");
  const [filterDateOption, setFilterDateOption] = useState("specific");
  const [specificDate, setSpecificDate] = useState(() => {
    const fecha = toLocalISOString(new Date());
    console.log("🎯 KANBAN: specificDate inicializado con:", fecha);
    console.log("🎯 KANBAN: fecha actual (new Date()):", new Date());
    console.log("🎯 KANBAN: toLocalISOString result:", fecha);
    return fecha;
  });
  const [selectedDeposit, setSelectedDeposit] = useState(null);
  const selectedDepositRef = useRef(null);
  const modalOpenTimeRef = useRef(0);
  const hasRestoredRef = useRef(false);

  // Estados para colapsar/expandir secciones de "En Validación"
  const [showNormales, setShowNormales] = useState(true);
  const [showAntiguos, setShowAntiguos] = useState(true);

  // Estados para colapsar/expandir secciones de "Pendiente"
  const [showPendientesEspeciales, setShowPendientesEspeciales] =
    useState(true);
  const [showPendientesOtros, setShowPendientesOtros] = useState(true);

  // Estado para modal de contactos
  const [showContactosModal, setShowContactosModal] = useState(false);
  const [selectedValidatorFilter, setSelectedValidatorFilter] = useState(null);
  const [replyToWhatsAppMessages, setReplyToWhatsAppMessages] = useState(() => {
    try {
      const storedValue = localStorage.getItem("kanban_reply_to_whatsapp");
      if (storedValue === "off") return false;
      if (storedValue === "on") return true;
      return true;
    } catch {
      return true;
    }
  });
  const isCompactKanban = detailPresentationMode === "compact";

  useEffect(() => {
    try {
      localStorage.setItem(
        "kanban_reply_to_whatsapp",
        replyToWhatsAppMessages ? "on" : "off",
      );
    } catch {
      // ignore storage failures
    }
  }, [replyToWhatsAppMessages]);

  const getUserInitials = useCallback((name) => {
    const cleanName = String(name || "").trim();
    if (!cleanName) return "??";

    return (
      cleanName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase() || "??"
    );
  }, []);

  // Fetch deposits cuando cambia la fecha específica (incluyendo montaje inicial)
  useEffect(() => {
    console.log("🔄 KANBAN useEffect ejecutado:", {
      onFetchDepositsByDate: !!onFetchDepositsByDate,
      filterDateOption,
      specificDate,
    });

    const loadDate = onSelectDate || onFetchDepositsByDate;
    if (!loadDate) {
      console.log("⚠️ KANBAN: no hay handler para cargar depósitos por fecha");
      return;
    }

    if (filterDateOption === "specific" && specificDate) {
      console.log(
        "🔄 KANBAN: Solicitando depósitos para fecha específica:",
        specificDate,
      );
      loadDate(specificDate);
    } else if (filterDateOption === "today") {
      const today = toLocalISOString(new Date());
      console.log("🔄 KANBAN: Solicitando depósitos para hoy:", today);
      loadDate(today);
    } else if (filterDateOption === "all") {
      console.log(
        "🔄 KANBAN: Opción 'Cualquier fecha' seleccionada - cargando TODOS los depósitos",
      );
      if (onSelectDate) {
        onSelectDate(null);
      } else if (onFetchAllDeposits) {
        onFetchAllDeposits();
      } else {
        console.warn("⚠️ KANBAN: onFetchAllDeposits no está disponible");
      }
    } else {
      console.log(
        "⚠️ KANBAN: No se cumple ninguna condición para cargar depósitos. filterDateOption:",
        filterDateOption,
        "specificDate:",
        specificDate,
      );
    }
  }, [
    specificDate,
    filterDateOption,
    onSelectDate,
    onFetchDepositsByDate,
    onFetchAllDeposits,
  ]);

  // Notificar a App cuando cambie la fecha seleccionada
  useEffect(() => {
    if (onSelectedDateChange && specificDate) {
      console.log(
        "📅 KANBAN: Notificando cambio de fecha a App:",
        specificDate,
      );
      onSelectedDateChange(specificDate);
    }
  }, [specificDate, onSelectedDateChange]);

  // Mantener ref actualizada y registrar tiempo de apertura
  useEffect(() => {
    selectedDepositRef.current = selectedDeposit;
    if (selectedDeposit) {
      modalOpenTimeRef.current = Date.now();
      console.log(
        "📂 KANBAN: Modal abierto, guardando en localStorage. ID:",
        selectedDeposit.id,
      );

      // Guardar ID del depósito abierto para restaurar después del reload
      saveOpenDepositId(selectedDeposit.id);
    } else {
      // No limpiar automáticamente localStorage aquí
      // Se limpia explícitamente en handleCloseModal cuando el usuario cierra el modal
      console.log("🔒 KANBAN: Modal cerrado (selectedDeposit es null)");
    }
  }, [selectedDeposit]);

  // Restaurar modal después de page reload
  useEffect(() => {
    // Solo restaurar una vez al cargar
    if (hasRestoredRef.current) return;

    console.log(
      "🔍 KANBAN: Verificando restauración inicial. deposits:",
      deposits?.length,
    );

    if (deposits && deposits.length > 0) {
      const wasRestored = restoreOpenDeposit(
        deposits,
        setSelectedDeposit,
        selectedDeposit,
      );
      hasRestoredRef.current = true;

      if (wasRestored) {
        console.log(
          "✅ KANBAN: Modal restaurado exitosamente en carga inicial",
        );
      } else {
        console.log("ℹ️ KANBAN: No hay modal para restaurar en carga inicial");
      }
    }
  }, [deposits, selectedDeposit]);

  // Monitor deposits prop changes
  useEffect(() => {
    console.log("📊 KANBAN: Prop deposits actualizada:", deposits?.length);
  }, [deposits]);

  // 👁️ Restaurar modal cuando la pestaña vuelve a estar visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log(
          "👁️ KANBAN: Pestaña visible, verificando si hay modal para restaurar",
        );
        restoreOpenDeposit(deposits, setSelectedDeposit, selectedDeposit);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [deposits, selectedDeposit]);

  // Monitorear cambios en selectedDeposit
  useEffect(() => {
    console.log(
      "🔍 KANBAN: selectedDeposit cambió:",
      selectedDeposit
        ? {
            id: selectedDeposit.id,
            estado: selectedDeposit.estado,
            es_antiguo: selectedDeposit.es_antiguo,
          }
        : "null",
    );
  }, [selectedDeposit]);

  // CRÍTICO: Sincronizar selectedDeposit cuando deposits cambia (por Realtime)
  useEffect(() => {
    if (selectedDeposit && deposits && deposits.length > 0) {
      // Buscar la versión actualizada del depósito seleccionado
      const updatedDeposit = deposits.find((d) => d.id === selectedDeposit.id);

      if (updatedDeposit) {
        // Verificar si hay cambios reales
        const hasChanges =
          updatedDeposit.es_antiguo !== selectedDeposit.es_antiguo ||
          updatedDeposit.estado !== selectedDeposit.estado ||
          updatedDeposit.monto !== selectedDeposit.monto;

        if (hasChanges) {
          console.log(
            "🔄 KANBAN: Actualizando selectedDeposit con datos de Realtime",
            {
              id: updatedDeposit.id,
              es_antiguo_prev: selectedDeposit.es_antiguo,
              es_antiguo_new: updatedDeposit.es_antiguo,
              estado: updatedDeposit.estado,
            },
          );
          setSelectedDeposit(updatedDeposit);
        }
      }
    }
  }, [deposits, selectedDeposit]);

  // Detectar cambios de visibilidad de la página
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log(
          "🟢 KANBAN: Página visible - Los clicks deberían funcionar",
        );
      } else {
        console.log("🔴 KANBAN: Página oculta - Inactividad detectada");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Debounce search term con 300ms de delay
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchTerm]);

  const columns = [
    { id: "pendiente", title: "Pendiente", color: "bg-orange-400" },
    { id: "en_validacion", title: "En Validación", color: "bg-blue-400" },
    { id: "validado", title: "Validado", color: "bg-green-400" },
    { id: "rechazado", title: "Rechazado", color: "bg-red-400" },
  ];

  const filteredDeposits = useMemo(() => {
    if (!deposits || !Array.isArray(deposits)) {
      console.log(
        "⚠️ KANBAN: No hay deposits o no es array:",
        deposits?.length,
      );
      return [];
    }

    console.log("🔍 KANBAN: Filtrando deposits:", {
      total: deposits.length,
      filterDateOption,
      specificDate,
      searchTerm: debouncedSearchTerm,
    });
    // Debug: mostrar las primeras 5 fechas disponibles
    const fechasDisponibles = deposits.slice(0, 5).map((d) => ({
      id: d.id,
      fecha_solo_date: d.fecha_solo_date,
      fecha_registro: d.fecha_registro?.substring(0, 10),
    }));
    console.log(
      "📅 KANBAN: Fechas disponibles (primeros 5):",
      fechasDisponibles,
    );
    const parsedAmountSearch = normalizeAmountInput(amountSearch);
    const normalizedBranchSearch = branchPersonSearch.toLowerCase().trim();
    const selectedDateFilter =
      filterDateOption === "specific"
        ? specificDate
        : filterDateOption === "today"
          ? toLocalISOString(new Date())
          : null;

    const filtered = deposits.filter((deposit) => {
      const lowerCaseSearchTerm = debouncedSearchTerm.toLowerCase();

      const formattedDateTime = new Date(deposit.fecha_registro).toLocaleString(
        "es-ES",
        {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        },
      );

      const matchesSearch =
        !debouncedSearchTerm ||
        (deposit.cliente &&
          deposit.cliente.toLowerCase().includes(lowerCaseSearchTerm)) ||
        (deposit.ruc_cliente &&
          deposit.ruc_cliente.toLowerCase().includes(lowerCaseSearchTerm)) ||
        (deposit.numero_operacion &&
          deposit.numero_operacion
            .toLowerCase()
            .includes(lowerCaseSearchTerm)) ||
        (deposit.sucursal?.nombre &&
          deposit.sucursal.nombre
            .toLowerCase()
            .includes(lowerCaseSearchTerm)) ||
        (deposit.banco?.abreviatura &&
          deposit.banco.abreviatura
            .toLowerCase()
            .includes(lowerCaseSearchTerm)) ||
        (deposit.trabajador?.nombre &&
          deposit.trabajador.nombre
            .toLowerCase()
            .includes(lowerCaseSearchTerm)) ||
        (deposit.moneda &&
          deposit.moneda.toLowerCase().includes(lowerCaseSearchTerm)) ||
        (deposit.monto &&
          deposit.monto.toString().includes(lowerCaseSearchTerm)) ||
        formattedDateTime.includes(lowerCaseSearchTerm);

      const montoValue = Number(deposit.monto);
      const searchAmountText = amountSearch.trim();
      const montoText = deposit.monto != null ? String(deposit.monto) : "";
      const montoFormatted = Number.isFinite(montoValue)
        ? montoValue.toLocaleString("es-ES", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        : "";
      const matchesAmount =
        parsedAmountSearch == null ||
        (Number.isFinite(montoValue) &&
          (montoValue === parsedAmountSearch ||
            montoText.includes(searchAmountText) ||
            montoFormatted.includes(searchAmountText) ||
            montoValue.toFixed(2).includes(parsedAmountSearch.toFixed(2))));

      const matchesBranchPerson =
        !normalizedBranchSearch ||
        (deposit.trabajador?.nombre &&
          deposit.trabajador.nombre.toLowerCase().includes(normalizedBranchSearch)) ||
        (deposit.trabajador?.telefono_origen &&
          deposit.trabajador.telefono_origen.toLowerCase().includes(normalizedBranchSearch));

      const matchesDate =
        !selectedDateFilter || deposit.fecha_solo_date === selectedDateFilter;

      return matchesDate && matchesSearch && matchesAmount && matchesBranchPerson;
    });

    console.log(
      "✅ KANBAN: Resultado filtrado:",
      filtered.length,
      "de",
      deposits.length,
    );
    return filtered;
  }, [deposits, debouncedSearchTerm, amountSearch, branchPersonSearch]);

  const attendedUsersSummary = useMemo(() => {
    const userList = Array.isArray(users) ? users : [];
    const countsByKey = new Map();

    filteredDeposits.forEach((deposit) => {
      const validatorId = deposit?.validado_por ?? deposit?.validado_por_usuario?.id ?? null;
      const validatorName = String(
        deposit?.validado_por_usuario?.nombre ||
          deposit?.validado_por_nombre ||
          deposit?.validado_por ||
          "",
      ).trim();

      if (!validatorId && !validatorName) return;

      const resolvedUser = validatorId
        ? userList.find((user) => String(user.id) === String(validatorId)) || null
        : null;

      const key = String(resolvedUser?.id || validatorId || validatorName.toLowerCase());
      const name = resolvedUser?.nombre || validatorName || resolvedUser?.usuario || "Usuario";

      const current = countsByKey.get(key) || { key, name, count: 0 };
      current.count += 1;
      current.name = name;
      countsByKey.set(key, current);
    });

    return Array.from(countsByKey.values())
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "es"));
  }, [filteredDeposits, users]);

  const handleValidatorFilterToggle = useCallback((user) => {
    if (!user) return;

    setSelectedValidatorFilter((current) => {
      if (current?.key === user.key) {
        return null;
      }

      return {
        key: user.key,
        name: user.name,
      };
    });
  }, []);

  const clearValidatorFilter = useCallback(() => {
    setSelectedValidatorFilter(null);
  }, []);

  const visibleDeposits = useMemo(() => {
    if (!selectedValidatorFilter) {
      return filteredDeposits;
    }

    const selectedKey = String(selectedValidatorFilter.key || "").toLowerCase();

    return filteredDeposits.filter((deposit) => {
      const validatorId = deposit?.validado_por ?? deposit?.validado_por_usuario?.id ?? null;
      const validatorName = String(
        deposit?.validado_por_usuario?.nombre ||
          deposit?.validado_por_nombre ||
          deposit?.validado_por ||
          "",
      ).trim();

      const depositKey = String(validatorId || validatorName.toLowerCase()).toLowerCase();
      return depositKey === selectedKey;
    });
  }, [filteredDeposits, selectedValidatorFilter]);

  const groupedDeposits = useMemo(() => {
    const grouped = visibleDeposits.reduce((acc, deposit) => {
      if (!acc[deposit.estado]) {
        acc[deposit.estado] = [];
      }
      acc[deposit.estado].push(deposit);
      return acc;
    }, {});

    // Ordenar cada grupo
    Object.keys(grouped).forEach((estado) => {
      grouped[estado].sort((a, b) => {
        const dateA = new Date(a.fecha_registro);
        const dateB = new Date(b.fecha_registro);

        // Para "validado" y "rechazado": más recientes primero (descendente)
        if (estado === "validado" || estado === "rechazado") {
          return dateB - dateA; // Descendente: más recientes arriba
        }

        // Para "pendiente" y "en_validacion": más antiguos primero (ascendente)
        return dateA - dateB; // Ascendente: más antiguos arriba
      });
    });

    return grouped;
  }, [visibleDeposits]);

  // Separar depósitos en validación en normales y antiguos
  const validacionSeparated = useMemo(() => {
    const enValidacion = groupedDeposits["en_validacion"] || [];
    return {
      normales: enValidacion.filter((d) => !d.es_antiguo),
      antiguos: enValidacion.filter((d) => d.es_antiguo),
    };
  }, [groupedDeposits]);

  // Separar depósitos pendientes por número de teléfono 981199322
  const pendientesSeparated = useMemo(() => {
    const pendientes = groupedDeposits["pendiente"] || [];
    return {
      especiales: pendientes.filter((d) => {
        // Verificar si el trabajador tiene el número específico
        const telefono = d.trabajador?.telefono_origen;
        if (!telefono) return false;

        // Normalizar el teléfono (quitar +51 si lo tiene)
        const telefonoNormalizado = telefono.startsWith("51")
          ? telefono.slice(2)
          : telefono;
        return telefonoNormalizado === "981199322";
      }),
      otros: pendientes.filter((d) => {
        const telefono = d.trabajador?.telefono_origen;
        if (!telefono) return true; // Si no hay teléfono, va a "otros"

        const telefonoNormalizado = telefono.startsWith("51")
          ? telefono.slice(2)
          : telefono;
        return telefonoNormalizado !== "981199322";
      }),
    };
  }, [groupedDeposits]);

  const handleCardClick = useCallback(
    async (deposit) => {
      console.log("👆 KANBAN: Click en card detectado", {
        depositId: deposit.id,
        estado: deposit.estado,
        timestamp: new Date().toISOString(),
      });

      console.log("📂 KANBAN: Abriendo modal de forma optimista");
      setSelectedDeposit(deposit);

      if (deposit.estado === "pendiente" && currentUser) {
        console.log("🔄 KANBAN: Es pendiente, llamando onTakeDeposit en segundo plano...");
        console.log("⏳ KANBAN: Esperando respuesta del servidor...");

        const startTime = Date.now();
        const updatedDeposit = await onTakeDeposit(deposit);
        const endTime = Date.now();

        console.log(
          `⏱️ KANBAN: onTakeDeposit completado en ${endTime - startTime}ms`,
        );
        console.log("📦 KANBAN: Resultado de onTakeDeposit:", {
          success: !!updatedDeposit,
          id: updatedDeposit?.id,
          estado: updatedDeposit?.estado,
          validado_por: updatedDeposit?.validado_por,
          validado_por_usuario: updatedDeposit?.validado_por_usuario,
          tiene_validado_por_usuario: !!updatedDeposit?.validado_por_usuario,
        });

        if (updatedDeposit) {
          console.log("✅ KANBAN: Sincronizando modal con depósito actualizado");
          setSelectedDeposit(updatedDeposit);
        } else {
          console.error(
            "❌ KANBAN: onTakeDeposit devolvió null/undefined - el modal ya fue abierto, pero la toma falló",
          );
          alert(
            "No se pudo tomar el depósito para validación. Revisa la consola para más detalles.",
          );
        }
      }

      console.log("🎬 KANBAN: Fin de handleCardClick");
    },
    [currentUser, onTakeDeposit],
  );

  const handleCloseModal = useCallback(() => {
    const now = Date.now();
    const timeSinceOpen = now - modalOpenTimeRef.current;

    console.log("🚪 KANBAN: handleCloseModal llamado", {
      timeSinceOpen,
      modalOpenTime: modalOpenTimeRef.current,
    });

    // Ignorar cierres que ocurren menos del tiempo mínimo después de abrir
    // Esto previene cierres accidentales/automáticos
    if (timeSinceOpen < PERSISTENCE_CONFIG.MIN_MODAL_OPEN_TIME) {
      console.log("⚠️ KANBAN: Cierre ignorado - modal recién abierto");
      return;
    }

    console.log(
      "🚪 KANBAN: Cerrando modal - el depósito mantiene su estado actual",
    );

    // Limpiar localStorage ya que el usuario cerró explícitamente el modal
    clearOpenDepositId();

    // NO regresar a pendiente - el depósito se queda en su estado actual
    // Esto permite que los depósitos "en_validacion" permanezcan ahí aunque se cierre el modal

    setSelectedDeposit(null);
  }, []);

  return (
    <>
      <div className="h-full p-6 flex flex-col bg-gray-50 dark:bg-gray-950">
        {/* Header con título y botones en la misma línea */}
        <div className="flex flex-col gap-3 mb-4 flex-shrink-0">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap">
              Kanban de Depósitos
            </h2>

            {!isCompactKanban && showConnectionStatus && connectionStatus && (
              <div className="ml-auto rounded-full border border-gray-200 bg-white/80 px-3 py-2 shadow-sm backdrop-blur dark:border-gray-700 dark:bg-gray-900/80">
                <ConnectionIndicator
                  supabaseConnected={connectionStatus.supabaseConnected}
                  realtimeStatus={connectionStatus.realtimeStatus}
                  realtimeErrors={connectionStatus.realtimeErrors}
                />
              </div>
            )}
          </div>

          {!isCompactKanban && attendedUsersSummary.length > 0 && (
            <div className="lg:hidden flex items-center gap-2">
              <div className="min-w-0 flex-1 overflow-x-auto pb-1">
                <DailyAttendanceSummary
                  selectedDate={specificDate}
                  items={attendedUsersSummary}
                  compact
                  showLabel={false}
                  selectedKey={selectedValidatorFilter?.key}
                  onItemClick={handleValidatorFilterToggle}
                  className="w-max"
                />
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {selectedValidatorFilter && (
                  <button
                    type="button"
                    onClick={clearValidatorFilter}
                    className="inline-flex items-center justify-center rounded-lg border border-red-200 bg-red-50 p-2 text-red-700 shadow-sm transition-colors hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200 dark:hover:bg-red-950/50"
                    title={`Limpiar filtro: ${selectedValidatorFilter.name}`}
                    aria-label={`Limpiar filtro de ${selectedValidatorFilter.name}`}
                  >
                    <X size={14} />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setReplyToWhatsAppMessages((prev) => !prev)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-colors ${
                    replyToWhatsAppMessages
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-gray-900 dark:text-slate-200 dark:hover:bg-gray-800"
                  }`}
                  title={
                    replyToWhatsAppMessages
                      ? "Responder a mensajes de WhatsApp cuando sea posible"
                      : "Enviar mensajes nuevos en lugar de responder al hilo"
                  }
                >
                  {replyToWhatsAppMessages ? (
                    <ToggleRight className="h-4 w-4" />
                  ) : (
                    <ToggleLeft className="h-4 w-4" />
                  )}
                  <span className="hidden sm:inline">
                    {replyToWhatsAppMessages ? "Responder On" : "Responder Off"}
                  </span>
                </button>

                <button
                  onClick={() => setShowContactosModal(true)}
                  className="flex items-center gap-2 rounded-lg bg-green-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-green-600"
                  title="Ver todos los contactos"
                >
                  <MessageCircle size={16} />
                  <span className="hidden sm:inline">Contactos</span>
                </button>
              </div>
            </div>
          )}

          {!isCompactKanban && attendedUsersSummary.length > 0 && (
            <div className="hidden flex-wrap items-center gap-2 lg:flex">
              {attendedUsersSummary.map((user) => (
                <button
                  key={user.key}
                  type="button"
                  onClick={() => handleValidatorFilterToggle(user)}
                  aria-pressed={selectedValidatorFilter?.key === user.key}
                  className={`flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-1 shadow-sm backdrop-blur transition-all ${
                    selectedValidatorFilter?.key === user.key
                      ? "alarm-flash border-red-600 bg-red-100 text-slate-900 shadow-lg shadow-red-500/30 dark:border-red-500 dark:bg-red-200 dark:text-slate-900"
                      : "border-slate-200 bg-white/90 hover:border-red-300 hover:bg-red-50 dark:border-slate-700 dark:bg-gray-900/90 dark:hover:border-red-700 dark:hover:bg-red-950/20"
                  }`}
                  title={`${user.name}: ${user.count} depósito${user.count === 1 ? "" : "s"} atendido${user.count === 1 ? "" : "s"}`}
                >
                  <div
                    className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${
                      selectedValidatorFilter?.key === user.key
                        ? "from-red-200 to-red-100 text-slate-900"
                        : "from-slate-800 to-slate-600 text-white dark:from-slate-100 dark:to-slate-300 dark:text-slate-900"
                    } text-[10px] font-bold`}
                  >
                    {user.count}
                  </div>
                  <span className="max-w-28 truncate text-[11px] font-medium leading-tight text-gray-600 dark:text-gray-300">
                    {user.name}
                  </span>
                </button>
              ))}
              {selectedValidatorFilter && (
                <button
                  type="button"
                  onClick={clearValidatorFilter}
                  className="flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-100 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200 dark:hover:bg-red-950/50"
                >
                  <span>Filtro: {selectedValidatorFilter.name}</span>
                  <span className="rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white">
                    Limpiar
                  </span>
                </button>
              )}

              <div className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setReplyToWhatsAppMessages((prev) => !prev)}
                  className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold shadow-sm transition-colors ${
                    replyToWhatsAppMessages
                      ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-gray-900 dark:text-slate-200 dark:hover:bg-gray-800"
                  }`}
                  title={
                    replyToWhatsAppMessages
                      ? "Responder a mensajes de WhatsApp cuando sea posible"
                      : "Enviar mensajes nuevos en lugar de responder al hilo"
                  }
                >
                  {replyToWhatsAppMessages ? (
                    <ToggleRight className="h-5 w-5" />
                  ) : (
                    <ToggleLeft className="h-5 w-5" />
                  )}
                  <span className="hidden sm:inline">
                    {replyToWhatsAppMessages ? "Responder On" : "Responder Off"}
                  </span>
                </button>

                <button
                  onClick={() => setShowContactosModal(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors shadow-sm"
                  title="Ver todos los contactos"
                >
                  <MessageCircle size={18} />
                  <span className="hidden sm:inline">Contactos</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Filtros y búsqueda en una segunda línea */}
        <div className="mb-6 flex flex-nowrap items-center gap-2 overflow-hidden flex-shrink-0 lg:hidden">
          <div className="relative w-[38%] min-w-[112px] shrink-0">
            <Calendar
              size={12}
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
            />
            <input
              type="date"
              value={specificDate}
              onChange={(e) => {
                const newDate = e.target.value;
                console.log("📅 INPUT: Usuario seleccionó fecha:", newDate);
                setFilterDateOption("specific");
                setSpecificDate(newDate);
                if (onSelectDate) {
                  onSelectDate(newDate || null);
                }
              }}
              className="w-full min-w-0 pl-9 pr-2 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
            />
          </div>

          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              placeholder="Buscar..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full min-w-0 pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
            />
          </div>
        </div>

        <div className="hidden flex-wrap items-center gap-4 mb-6 flex-shrink-0 lg:flex">
          {isCompactKanban ? (
            <>
              <div className="relative">
                <Calendar
                  size={12}
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                />
                <input
                  type="date"
                  value={specificDate}
                  onChange={(e) => {
                    const newDate = e.target.value;
                    console.log("📅 INPUT: Usuario seleccionó fecha:", newDate);
                    setSpecificDate(newDate);
                    if (onSelectDate) {
                      onSelectDate(newDate || null);
                    }
                  }}
                  className="w-full md:w-auto pl-9 pr-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                />
              </div>

              <div className="relative ml-auto">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                />
                <input
                  type="text"
                  placeholder="Buscar..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full md:w-56 pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                />
              </div>
            </>
          ) : (
            <>
              <div className="relative">
                <Calendar
                  size={12}
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                />
                <select
                  value={filterDateOption}
                  onChange={(e) => setFilterDateOption(e.target.value)}
                  className="w-full md:w-auto pl-9 pr-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                >
                  <option value="all">Cualquier fecha</option>
                  <option value="today">Hoy</option>
                  <option value="specific">Fecha específica</option>
                </select>
              </div>

              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="Importe..."
                  value={amountSearch}
                  onChange={(e) => setAmountSearch(e.target.value)}
                  className="w-full md:w-40 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                />
              </div>

              <div className="relative">
                <input
                  type="text"
                  placeholder="Persona sucursal..."
                  value={branchPersonSearch}
                  onChange={(e) => setBranchPersonSearch(e.target.value)}
                  className="w-full md:w-56 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                />
              </div>

              <AnimatePresence>
                {filterDateOption === "specific" && (
                  <motion.div
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    className="relative"
                    transition={{ duration: 0.2 }}
                  >
                    <input
                      type="date"
                      value={specificDate}
                      onChange={(e) => {
                        const newDate = e.target.value;
                        console.log("📅 INPUT: Usuario seleccionó fecha:", newDate);
                        console.log("📅 INPUT: Fecha anterior era:", specificDate);
                        console.log(
                          "📅 INPUT: onFetchDepositsByDate disponible:",
                          !!onFetchDepositsByDate,
                        );
                        setSpecificDate(newDate);
                        if (onSelectDate) {
                          onSelectDate(newDate || null);
                        }
                      }}
                      className="w-full md:w-auto px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="relative ml-auto">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                />
                <input
                  type="text"
                  placeholder="Buscar..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full md:w-56 pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-blue-500 dark:focus:border-blue-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-200"
                />
              </div>
            </>
          )}
        </div>

        {/* Mobile Accordion View */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 lg:hidden">
          {columns.map((column, index) => (
            <details
              key={column.id}
              className="group overflow-hidden rounded-xl border border-gray-200/80 bg-gray-100/70 shadow-sm transition-shadow hover:shadow-md dark:border-gray-700/80 dark:bg-gray-900/70"
              open={index === 0}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between p-4">
                <h3 className="font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${column.color}`}
                  ></span>
                  {column.title}
                </h3>
                <div className="flex items-center gap-4">
                  <span className="bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-1 rounded-full text-sm font-medium">
                    {groupedDeposits[column.id]?.length || 0}
                  </span>
                  <ChevronRight
                    className="transition-transform duration-200 group-open:rotate-90 text-gray-500 dark:text-gray-400"
                    size={14}
                  />
                </div>
              </summary>
              <div className="p-3 space-y-3 border-t border-gray-200 dark:border-gray-800">
                {/* Si es la columna "en_validacion", mostrar dos secciones */}
                {column.id === "en_validacion" ? (
                  <>
                    {/* Sección: Normales */}
                    {validacionSeparated.normales.length > 0 && (
                      <div className="mb-4">
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setShowNormales(!showNormales)}
                        >
                          <div className="flex-1 h-px bg-blue-300 dark:bg-blue-700"></div>
                          <span className="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider px-2 py-1 bg-blue-100 dark:bg-blue-900/30 rounded-full border border-blue-300 dark:border-blue-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showNormales ? "" : "-rotate-90"
                              }`}
                            />
                            ✓ Normales ({validacionSeparated.normales.length})
                          </span>
                          <div className="flex-1 h-px bg-blue-300 dark:bg-blue-700"></div>
                        </div>
                        {showNormales && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={validacionSeparated.normales}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sección: Antiguos */}
                    {validacionSeparated.antiguos.length > 0 && (
                      <div>
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setShowAntiguos(!showAntiguos)}
                        >
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                          <span className="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded-full border border-orange-300 dark:border-orange-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showAntiguos ? "" : "-rotate-90"
                              }`}
                            />
                            ⚠️ Antiguos ({validacionSeparated.antiguos.length})
                          </span>
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                        </div>
                        {showAntiguos && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={validacionSeparated.antiguos}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Si no hay depósitos en validación */}
                    {validacionSeparated.antiguos.length === 0 &&
                      validacionSeparated.normales.length === 0 && (
                        <ColumnContent
                          deposits={[]}
                          onCardClick={handleCardClick}
                          selectedDepositId={selectedDeposit?.id}
                        />
                      )}
                  </>
                ) : column.id === "pendiente" ? (
                  <>
                    {/* Sección: Especiales (981199322) */}
                    {pendientesSeparated.especiales.length > 0 && (
                      <div className="mb-4">
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() =>
                            setShowPendientesEspeciales(
                              !showPendientesEspeciales,
                            )
                          }
                        >
                          <div className="flex-1 h-px bg-purple-300 dark:bg-purple-700"></div>
                          <span className="text-xs font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider px-2 py-1 bg-purple-100 dark:bg-purple-900/30 rounded-full border border-purple-300 dark:border-purple-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showPendientesEspeciales ? "" : "-rotate-90"
                              }`}
                            />
                            📞 981199322 (
                            {pendientesSeparated.especiales.length})
                          </span>
                          <div className="flex-1 h-px bg-purple-300 dark:bg-purple-700"></div>
                        </div>
                        {showPendientesEspeciales && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={pendientesSeparated.especiales}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sección: Otros */}
                    {pendientesSeparated.otros.length > 0 && (
                      <div>
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() =>
                            setShowPendientesOtros(!showPendientesOtros)
                          }
                        >
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                          <span className="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded-full border border-orange-300 dark:border-orange-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showPendientesOtros ? "" : "-rotate-90"
                              }`}
                            />
                            ✓ Otros Contactos (
                            {pendientesSeparated.otros.length})
                          </span>
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                        </div>
                        {showPendientesOtros && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={pendientesSeparated.otros}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Si no hay depósitos pendientes */}
                    {pendientesSeparated.especiales.length === 0 &&
                      pendientesSeparated.otros.length === 0 && (
                        <ColumnContent
                          deposits={[]}
                          onCardClick={handleCardClick}
                          selectedDepositId={selectedDeposit?.id}
                        />
                      )}
                  </>
                ) : (
                  <ColumnContent
                    deposits={groupedDeposits[column.id]}
                    onCardClick={handleCardClick}
                    selectedDepositId={selectedDeposit?.id}
                  />
                )}
              </div>
            </details>
          ))}
        </div>

        {/* Desktop Grid View */}
        <div className="hidden lg:grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 flex-1 min-h-0">
          {columns.map((column) => (
            <div
              key={column.id}
              className="flex flex-col overflow-hidden rounded-xl border border-gray-200/80 bg-gray-100/70 shadow-sm transition-shadow hover:shadow-md dark:border-gray-700/80 dark:bg-gray-900"
            >
              <div className="flex-shrink-0 border-b border-gray-200/80 p-4 dark:border-gray-700/80">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${column.color}`}
                    ></span>
                    {column.title}
                  </h3>
                  <span className="bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-2 py-1 rounded-full text-sm font-medium">
                    {groupedDeposits[column.id]?.length || 0}
                  </span>
                </div>
              </div>
              <div className="flex-1 p-3 space-y-3 overflow-y-auto">
                {/* Si es la columna "en_validacion", mostrar dos secciones */}
                {column.id === "en_validacion" ? (
                  <>
                    {/* Sección: Normales */}
                    {validacionSeparated.normales.length > 0 && (
                      <div className="mb-4">
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setShowNormales(!showNormales)}
                        >
                          <div className="flex-1 h-px bg-blue-300 dark:bg-blue-700"></div>
                          <span className="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase tracking-wider px-2 py-1 bg-blue-100 dark:bg-blue-900/30 rounded-full border border-blue-300 dark:border-blue-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showNormales ? "" : "-rotate-90"
                              }`}
                            />
                            ✓ Normales ({validacionSeparated.normales.length})
                          </span>
                          <div className="flex-1 h-px bg-blue-300 dark:bg-blue-700"></div>
                        </div>
                        {showNormales && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={validacionSeparated.normales}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sección: Antiguos */}
                    {validacionSeparated.antiguos.length > 0 && (
                      <div>
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setShowAntiguos(!showAntiguos)}
                        >
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                          <span className="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded-full border border-orange-300 dark:border-orange-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showAntiguos ? "" : "-rotate-90"
                              }`}
                            />
                            ⚠️ Antiguos ({validacionSeparated.antiguos.length})
                          </span>
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                        </div>
                        {showAntiguos && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={validacionSeparated.antiguos}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Si no hay depósitos en validación */}
                    {validacionSeparated.antiguos.length === 0 &&
                      validacionSeparated.normales.length === 0 && (
                        <ColumnContent
                          deposits={[]}
                          onCardClick={handleCardClick}
                          selectedDepositId={selectedDeposit?.id}
                        />
                      )}
                  </>
                ) : column.id === "pendiente" ? (
                  <>
                    {/* Sección: Especiales (981199322) */}
                    {pendientesSeparated.especiales.length > 0 && (
                      <div className="mb-4">
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() =>
                            setShowPendientesEspeciales(
                              !showPendientesEspeciales,
                            )
                          }
                        >
                          <div className="flex-1 h-px bg-purple-300 dark:bg-purple-700"></div>
                          <span className="text-xs font-bold text-purple-700 dark:text-purple-400 uppercase tracking-wider px-2 py-1 bg-purple-100 dark:bg-purple-900/30 rounded-full border border-purple-300 dark:border-purple-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showPendientesEspeciales ? "" : "-rotate-90"
                              }`}
                            />
                            📞 981199322 (
                            {pendientesSeparated.especiales.length})
                          </span>
                          <div className="flex-1 h-px bg-purple-300 dark:bg-purple-700"></div>
                        </div>
                        {showPendientesEspeciales && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={pendientesSeparated.especiales}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sección: Otros */}
                    {pendientesSeparated.otros.length > 0 && (
                      <div>
                        <div
                          className="flex items-center gap-2 mb-2 px-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() =>
                            setShowPendientesOtros(!showPendientesOtros)
                          }
                        >
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                          <span className="text-xs font-bold text-orange-700 dark:text-orange-400 uppercase tracking-wider px-2 py-1 bg-orange-100 dark:bg-orange-900/30 rounded-full border border-orange-300 dark:border-orange-700 flex items-center gap-1">
                            <ChevronDown
                              className={`w-3 h-3 transition-transform ${
                                showPendientesOtros ? "" : "-rotate-90"
                              }`}
                            />
                            ✓ Otros Contactos (
                            {pendientesSeparated.otros.length})
                          </span>
                          <div className="flex-1 h-px bg-orange-300 dark:bg-orange-700"></div>
                        </div>
                        {showPendientesOtros && (
                          <div className="space-y-3">
                            <ColumnContent
                              deposits={pendientesSeparated.otros}
                              onCardClick={handleCardClick}
                              selectedDepositId={selectedDeposit?.id}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Si no hay depósitos pendientes */}
                    {pendientesSeparated.especiales.length === 0 &&
                      pendientesSeparated.otros.length === 0 && (
                        <ColumnContent
                          deposits={[]}
                          onCardClick={handleCardClick}
                          selectedDepositId={selectedDeposit?.id}
                        />
                      )}
                  </>
                ) : (
                  <ColumnContent
                    deposits={groupedDeposits[column.id]}
                    onCardClick={handleCardClick}
                    selectedDepositId={selectedDeposit?.id}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <AnimatePresence>
        {selectedDeposit && (
          <DepositDetailModal
            deposit={selectedDeposit}
            onClose={handleCloseModal}
            onUpdateDeposit={onUpdateDeposit}
            empresas={empresas}
            bancos={bancos}
            cuentas={cuentas}
            onOpenVoucherWindow={onOpenVoucherWindow}
            presentationMode={detailPresentationMode}
            replyToWhatsAppMessages={replyToWhatsAppMessages}
          />
        )}
        {showContactosModal && (
          <ContactosModal onClose={() => setShowContactosModal(false)} />
        )}
      </AnimatePresence>
    </>
  );
};

export default KanbanView;

