import type { CopyDictionary } from "./en";

/**
 * Spanish copy. Typed against the English dictionary so a missing, renamed,
 * or re-typed key fails the build. Analyzer field labels, signal titles, and
 * synthesized field values translate through the fieldLabels, signalTitles,
 * and fieldValues tables below; signal DETAIL sentences are parametric and
 * intentionally remain English, marked lang="en" wherever they render.
 */
export const ES_COPY: CopyDictionary = Object.freeze({
  brand: "QRWarden",
  tagline: "Escanea. Inspecciona. Decide.",
  primaryMessage: "Mira qué contiene un código QR antes de actuar.",
  privacyStatement:
    "Los escaneos se quedan en este navegador. QRWarden no sube imágenes ni el contenido de los códigos.",
  noReviewHeading: "Sin señales que revisar.",
  noReviewBody:
    "QRWarden no encontró los patrones de URL sin conexión que requieren confirmación adicional. No visitó ni verificó este sitio web.",
  reviewHeading: "Revisa antes de abrir.",
  reviewBody: (count: number): string =>
    `QRWarden encontró ${count} ${count === 1 ? "detalle" : "detalles"} para revisar. Estas señales no demuestran que el sitio sea dañino.`,
  inspectOnlyHeading: "Decodificado para inspección.",
  inspectOnlyBody:
    "Revisa el contenido decodificado abajo. QRWarden no actúa sobre este tipo de código.",
  rawBytesHeading: "No se pudo confirmar la codificación.",
  rawBytesBody:
    "QRWarden no pudo confirmar cómo está codificado este texto, así que se muestra en bytes. QRWarden no adivina codificaciones.",
  emptyHeading: "Código QR vacío.",
  emptyBody: "Este código QR no contiene datos.",
  launchNotice:
    "Tu navegador o sistema operativo puede abrir este enlace en un navegador o en una aplicación instalada.",
  offlineLimitations:
    "Sin conexión no se comprueba: el contenido actual del sitio, redirecciones, reputación, titularidad ni el estado del certificado.",
  openLink: "Abrir enlace",
  continueToLink: "Continuar al enlace…",
  confirmHeading: "¿Abrir este enlace?",
  confirmBody: (destination: string): string =>
    `Estás a punto de abrir ${destination}. Revisa los detalles de arriba antes de continuar.`,
  confirmFullUrlLabel: "Dirección completa",
  cancel: "Cancelar",
  scanAnother: "Escanear otro código",
  chooseImage: "Elegir una imagen",
  retryCamera: "Probar la cámara otra vez",
  resumeScanning: "Reanudar el escaneo",
  tryAnotherCode: "Probar otro código",
  revealWarning: "El contenido sensible puede ser visible para personas cercanas.",
  clipboardWarning:
    "Tu sistema operativo o portapapeles en la nube puede compartir el contenido copiado con otros dispositivos o aplicaciones.",
  copied: "Copiado.",
  copyFailed: "No se pudo copiar este valor.",
  noQrHeading: "No se encontró ningún código QR.",
  noQrBody:
    "QRWarden no encontró un código QR en esta imagen. Prueba con una imagen más nítida, recorta más cerca del código y reduce los reflejos.",
  unsupportedCodeHeading: "Tipo de código no compatible.",
  unsupportedCodeBody:
    "Este es un formato de código que QRWarden no lee (por ejemplo, un código multiparte o no canónico).",
  tooManyHeading: "Demasiados códigos QR.",
  tooManyBody:
    "QRWarden encontró al menos nueve códigos QR. Recorta la imagen, acércate o escanea menos códigos a la vez.",
  chooseQrHeading: "Elige un código QR.",
  chooseQrBody: "QRWarden encontró varios códigos QR. Selecciona uno para inspeccionarlo.",
  timeoutHeading: "Tardó demasiado.",
  timeoutBody:
    "La lectura de esta imagen agotó el tiempo. Prueba con una imagen más pequeña o más clara.",
  imageTooLargeHeading: "Imagen demasiado grande.",
  imageTooLargeBody:
    "Esta imagen supera lo que QRWarden acepta. Usa una imagen de no más de 25 MB o unos 16,8 megapíxeles, y de no más de 8192 píxeles por lado.",
  unsupportedImageHeading: "Tipo de imagen no compatible.",
  unsupportedImageBody:
    "Usa una captura de pantalla o exporta esta imagen como JPEG, PNG o WebP.",
  imageUnreadableHeading: "Imagen ilegible.",
  imageUnreadableBody:
    "QRWarden no pudo leer esta imagen. Prueba con otro archivo JPEG, PNG o WebP.",
  chooseOneImageHeading: "Elige una sola imagen.",
  chooseOneImageBody: "Suelta una sola imagen JPEG, PNG o WebP a la vez.",
  shareBusyHeading: "Demasiadas imágenes compartidas.",
  shareBusyBody:
    "QRWarden ya está procesando cuatro imágenes compartidas. Vuelve a la aplicación desde la que compartiste e intenta compartir esta imagen de nuevo cuando terminen las anteriores.",
  shareMultipleFilesBody:
    "Se compartió más de una imagen. Vuelve a la aplicación desde la que compartiste y comparte una sola imagen JPEG, PNG o WebP a la vez.",
  shareTooLargeBody:
    "La imagen compartida supera los 25 MB. Vuelve a la aplicación desde la que compartiste y comparte una imagen más pequeña.",
  shareUnsupportedTypeBody:
    "El archivo compartido no es una imagen JPEG, PNG ni WebP. Vuelve a la aplicación desde la que compartiste y comparte una imagen compatible.",
  shareUnreadableBody:
    "QRWarden no pudo leer la imagen compartida. Vuelve a la aplicación desde la que compartiste y comparte otra imagen JPEG, PNG o WebP.",
  imageStoppedHeading: "La lectura de la imagen se detuvo.",
  imageStoppedBody:
    "La lectura se detuvo cuando QRWarden pasó a segundo plano. Vuelve a elegir la imagen para continuar.",
  readerStoppedHeading: "El lector se detuvo.",
  readerStoppedBody:
    "El lector de códigos se detuvo de forma inesperada. Vuelve al escáner e inténtalo de nuevo.",
  linkChangedHeading: "Se detuvo la apertura del enlace.",
  linkChangedBody:
    "QRWarden no pudo confirmar que esta acción siga correspondiendo al resultado que revisaste. Escanea el código otra vez.",
  preparingOfflineHeading: "Preparando el uso sin conexión.",
  preparingOfflineBody: "Configurando el uso sin conexión…",
  checkingVersionHeading: "Comprobando la versión de la aplicación.",
  checkingVersionBody:
    "El escaneo y los controles de revisión no están disponibles temporalmente mientras termina esta comprobación.",
  readyOfflineHeading: "Listo sin conexión.",
  readyOfflineBody: "QRWarden está listo para escanear sin conexión a internet.",
  offlineIncompleteHeading: "Configuración sin conexión incompleta.",
  offlineIncompleteBody:
    "La configuración sin conexión no terminó. QRWarden funciona con conexión y reintentará la configuración en el próximo inicio con internet.",
  updateReadyHeading: "Actualización lista.",
  updateReadyBody:
    "Hay una actualización de QRWarden lista. Elige Instalar actualización cuando el escaneo y la revisión estén inactivos.",
  updateFailedHeading: "Falló la actualización o la verificación.",
  updateFailedBody:
    "QRWarden no pudo terminar una actualización o verificar los archivos de la aplicación. Recarga con conexión si el escaneo sigue sin estar disponible.",
  reloadApp: "Recargar la aplicación",
  installUpdate: "Instalar actualización",
  updateBusyBody: "Termina o sal de esta pantalla y luego elige Instalar actualización.",
  updateStartingBody: "Iniciando la actualización…",
  updateUnavailableBody:
    "Esta actualización ya no está disponible. QRWarden volverá a comprobarlo cuando el escaneo y la revisión estén inactivos.",
  cameraUnavailableHeading: "Cámara no disponible.",
  cameraUnavailableBody:
    "El escaneo con cámara no está disponible aquí. Elige una imagen en su lugar.",
  cameraAccessHeading: "Se necesita acceso a la cámara.",
  cameraAccessBody:
    "Permite el acceso a la cámara para este sitio y navegador. En iPhone o iPad, abre Ajustes → Privacidad y seguridad → Cámara y activa tu navegador. También puedes elegir una imagen.",
  braveIosCameraBody:
    "Brave detectado: iOS concede la cámara a la aplicación Brave en su conjunto. Abre Ajustes → Apps → Brave, permite la Cámara y vuelve a intentarlo.",
  noCameraHeading: "No se encontró ninguna cámara.",
  noCameraBody:
    "No hay ninguna cámara disponible en este dispositivo. Elige una imagen en su lugar.",
  cameraStartHeading: "La cámara no pudo iniciarse.",
  cameraStartBody:
    "La cámara no respondió o no pudo iniciarse. Comprueba el permiso de cámara, cierra otras aplicaciones de cámara, inténtalo de nuevo o elige una imagen.",
  cameraStoppedHeading: "La cámara se detuvo.",
  cameraStoppedBody:
    "La cámara se detuvo. Toca Reanudar el escaneo para iniciarla de nuevo.",
  cameraPausedHeading: "Cámara en pausa.",
  cameraPausedBody:
    "El escaneo se detuvo mientras QRWarden estaba en segundo plano. Toca Reanudar el escaneo para continuar.",
  lookingForCode: "Buscando un código…",
  startingCamera: "Iniciando la cámara…",
  torchUnavailableHeading: "Linterna no disponible.",
  torchUnavailableBody:
    "No se pudo cambiar el ajuste de la linterna. El escaneo sigue activo.",
  zoomUnavailableHeading: "Zoom no disponible.",
  zoomUnavailableBody:
    "No se pudo cambiar el ajuste del zoom. El escaneo sigue activo.",
  switchUnavailableHeading: "Cambio de cámara no disponible.",
  switchUnavailableBody:
    "QRWarden no pudo cambiar de cámara. El escaneo continúa con la cámara anterior.",
  credentialsExplanation: (host: string): string =>
    `El texto antes de @ no es el destino. El host real es ${host}.`,
  installIphoneHeading: "iPhone o iPad",
  installIphone:
    "Abre Compartir, elige Añadir a pantalla de inicio, deja activado Abrir como app web cuando aparezca y luego abre QRWarden desde su icono de la pantalla de inicio con conexión. Espera a ver Listo sin conexión antes de usarlo sin internet.",
  installMacHeading: "Safari en Mac",
  installMac:
    "En macOS Sonoma o posterior, elige Archivo > Añadir al Dock, abre QRWarden desde el Dock con conexión y espera a ver Listo sin conexión. Safari en versiones anteriores de macOS no puede instalar aplicaciones web; QRWarden funciona igualmente en esta pestaña.",
  installTestedHeading: "Instalar QRWarden",
  installTested:
    "Usa la opción Instalar QRWarden de tu navegador, abre la aplicación instalada con conexión y espera a ver Listo sin conexión.",
  installUnavailableHeading: "Guía no disponible",
  installUnavailable:
    "No hay guía de instalación disponible para este navegador. Aun así puedes usar QRWarden en esta pestaña y prepararlo para el uso sin conexión.",
  installInstalledHeading: "Ya instalado",
  installInstalled:
    "Estás usando la aplicación QRWarden instalada en este dispositivo. No se necesitan pasos de instalación.",
  pasteHint: "También puedes pegar o soltar una imagen aquí.",
  signalNeedsReview: "Requiere revisión",
  signalContext: "Contexto",
  copyReportButton: "Copiar informe con datos ocultos",
  reportTitle: "Informe de inspección de QRWarden",
  reportHiddenValue: "(oculto)",
  reportPathSegmentsHidden: (count: number): string =>
    `(${count} ${count === 1 ? "segmento oculto" : "segmentos ocultos"})`,
  reportUrlEntriesHidden: (count: number): string =>
    `(${count} ${count === 1 ? "entrada" : "entradas"}; nombres y valores ocultos)`,
  reportQueryHidden: "(consulta oculta)",
  reportFragmentHidden: "(fragmento oculto)",
  reportKindLabel: "Tipo",
  reportStatusLabel: "Estado",
  reportSignalsLabel: "Señales",
  reportTruncatedNote: "(valor truncado para mostrarlo)",
  limitationContentOnly:
    "El análisis usa solo el contenido incluido en el código QR.",
  limitationNoVisit:
    "QRWarden no visita el destino ni comprueba reputación, DNS, TLS, redirecciones, antigüedad del dominio ni el contenido de la página.",
  skipToContent: "Saltar al contenido",
  brandHomeLabel: "Inicio de QRWarden",
  navInfoLabel: "Información",
  navPrivacy: "Privacidad",
  navAbout: "Acerca de",
  themeToggleLabel: "Oscuro",
  themeToggleName: "Modo oscuro",
  themeToLight: "Cambiar a modo claro",
  themeToDark: "Cambiar a modo oscuro",
  heroEyebrow: "Privado por diseño · analizado en el dispositivo",
  heroCopy:
    "Escanea con tu cámara o elige una imagen. QRWarden decodifica y explica el contenido en este dispositivo sin visitar el destino.",
  sourceCameraTitle: "Escanear con la cámara",
  sourceCameraBody: "Apunta tu cámara a un código QR",
  sourceImageTitle: "Elegir una imagen",
  sourceImageBody: "JPEG, PNG o WebP · hasta 25 MB",
  privacyPromiseTitle: "Tu escaneo se queda aquí.",
  stepsLabel: "Cómo funciona QRWarden",
  stepScan: "Escanea",
  stepScanDetail: "Cámara o imagen",
  stepInspect: "Inspecciona",
  stepInspectDetail: "Mira el contenido real",
  stepDecide: "Decide",
  stepDecideDetail: "Tú eliges qué ocurre",
  readingHeading: "Leyendo la imagen…",
  readingBody: "La imagen se está decodificando en este dispositivo.",
  cameraEyebrow: "Escaneo con cámara",
  cameraHeading: "Mantén el código QR dentro del marco",
  videoPreviewLabel: "Vista previa de la cámara en vivo",
  cameraSelectLabel: "Cámara",
  cameraSelectedAutomatically: "Cámara seleccionada automáticamente",
  zoomLabel: "Zoom",
  torchOn: "Encender la linterna",
  torchOff: "Apagar la linterna",
  selectionEyebrow: "Varios códigos",
  selectionUnavailable: "No disponible",
  unsupportedCodeChip: "Código no compatible",
  positionUnavailable: "posición no disponible",
  positionLabels: Object.freeze({
    "center": "centro",
    "left": "izquierda",
    "right": "derecha",
    "top": "arriba",
    "bottom": "abajo",
    "top left": "arriba a la izquierda",
    "top right": "arriba a la derecha",
    "bottom left": "abajo a la izquierda",
    "bottom right": "abajo a la derecha",
  }),
  selectionOptionLabel: (index: number, position: string, kind: string): string =>
    `Código ${index}, ${position}, ${kind}`,
  actualDestination: "Dirección en el código QR",
  signalsHeading: "Detalles a tener en cuenta",
  signalExplainerSummary: "Qué significa esto",
  contentsHeading: "Contenido decodificado",
  limitsHeading: "Qué no puede comprobar el análisis sin conexión",
  sensitiveChip: "Sensible",
  reveal: "Mostrar",
  mask: "Ocultar",
  copyField: (label: string): string => `Copiar ${label}`,
  showField: (label: string): string => `Mostrar ${label}`,
  hideField: (label: string): string => `Ocultar ${label}`,
  omittedFromDisplay: (omitted: number, total?: number): string =>
    total === undefined
      ? `${omitted} omitidos de la vista.`
      : `${omitted} omitidos de la vista (${total} en total).`,
  truncatedNote: "Valor truncado para mostrarlo.",
  lockedFieldDetails:
    "Detalles no disponibles mientras se comprueba la versión de la aplicación.",
  backToScanner: "Volver al escáner",
  backToReview: "Volver a la revisión",
  backToAbout: "Volver a la página Acerca de",
  privacyEyebrow: "Privacidad",
  privacyTitle: "Qué se queda en tu dispositivo",
  privacyNoLookupHeading: "Sin consultas al destino",
  privacyNoLookupBody:
    "QRWarden no visita los enlaces decodificados, no solicita favicons, no comprueba reputación ni envía el contenido de los escaneos a un servidor. El análisis usa solo los bytes del código QR y datos fijados incluidos con la aplicación.",
  privacyNoHistoryHeading: "Sin historial de escaneos",
  privacyNoHistoryBody:
    "Las imágenes, el contenido decodificado y los informes se conservan solo en memoria mientras los revisas. No se guardan en bases de datos del navegador, cachés ni URL. Las cachés sin conexión contienen solo archivos de la aplicación, y un marcador de sesión de corta duración puede contener un identificador de versión mientras se activa una actualización verificada; ninguno contiene el contenido de los escaneos. QRWarden también puede guardar tu preferencia de apariencia clara u oscura.",
  privacyHostingHeading: "Tráfico de alojamiento de la aplicación",
  privacyHostingBody:
    "Abrir o actualizar QRWarden envía solicitudes HTTPS ordinarias de archivos de la aplicación al host. El host, el proveedor de alojamiento y la red pueden observar metadatos de conexión como tu dirección IP, la hora de la solicitud, el agente de usuario y los archivos solicitados. QRWarden no añade el contenido de los escaneos a esas solicitudes.",
  privacyActionsHeading: "Acciones que tú controlas",
  privacyActionsBody:
    "Abrir un enlace lo envía a tu navegador o sistema operativo. Copiar coloca el valor revisado en el portapapeles de tu sistema, que puede sincronizarse con otros dispositivos o aplicaciones.",
  aboutEyebrow: "Acerca de",
  aboutTitle: "Hecho para mostrar evidencia, no un veredicto.",
  aboutLead:
    "QRWarden explica propiedades observables de un código QR. Nunca califica un destino como seguro, confiable, malicioso o verificado.",
  glossaryLink: "Qué significa cada señal de revisión",
  appearanceHeading: "Apariencia",
  appearanceFollowing: (theme: string): string =>
    `Siguiendo la apariencia ${theme === "dark" ? "oscura" : "clara"} de este dispositivo.`,
  appearanceUsing: (theme: string): string =>
    `Usando el modo ${theme === "dark" ? "oscuro" : "claro"} en este dispositivo.`,
  useDeviceSetting: "Usar el ajuste del dispositivo",
  usingDeviceSetting: "Usando el ajuste del dispositivo",
  technicalDetails: "Detalles técnicos y de versión",
  aboutReleaseLabel: "Versión de la aplicación",
  analyzerLabel: "Analizador",
  aboutPslSnapshotLabel: "Instantánea de la PSL",
  aboutIanaSnapshotLabel: "Instantánea de IANA",
  aboutUnicodeLabel: "Unicode",
  aboutCodeLicenseLabel: "Licencia del código propio",
  aboutDataLicensesLabel: "Licencias de los datos incluidos",
  aboutFingerprintLabel: "Huella de la clave de versión",
  aboutPublicKeyLabel: "Clave pública de versión",
  aboutDnsAnchorLabel: "Ancla de confianza DNS",
  aboutSourceLabel: "Código fuente",
  notConfiguredValue: "No configurado en esta compilación de desarrollo",
  aboutEnglishEvidenceNote:
    "Los detalles técnicos de las señales se muestran actualmente en inglés.",
  glossaryEyebrow: "Glosario de señales",
  glossaryTitle: "Qué significa cada señal",
  glossaryLead:
    "Las señales describen propiedades observables de un código decodificado. Son evidencia para sopesar, no un veredicto sobre el destino.",
  footerFacts: "Solo análisis local. Sin analíticas ni telemetría. Sin veredictos.",
  footerLicense: "QRWarden · AGPL-3.0-or-later",
  titleCamera: "Escaneo con cámara",
  titleReading: "Leyendo la imagen",
  titleSelection: "Elige un código QR",
  titleResult: "Resultado de la inspección",
  titleError: "Problema de escaneo",
  titlePrivacy: "Privacidad",
  titleAbout: "Acerca de",
  titleGlossary: "Glosario de señales",
  fieldLabels: Object.freeze({
    "Action": "Acción",
    "Address": "Dirección",
    "Anonymous identity": "Identidad anónima",
    "Byte count": "Cantidad de bytes",
    "Calendar": "Calendario",
    "Complete bootstrap payload": "Carga útil completa de arranque",
    "Complete setup payload": "Carga útil completa de configuración",
    "Contact": "Contacto",
    "Coordinates": "Coordenadas",
    "Decoded content": "Contenido decodificado",
    "Description": "Descripción",
    "Destination category": "Categoría del destino",
    "Destination host": "Host de destino",
    "Email": "Correo electrónico",
    "Email BCC": "CCO del correo",
    "Email CC": "CC del correo",
    "Email body": "Cuerpo del correo",
    "Email recipient": "Destinatario del correo",
    "Email subject": "Asunto del correo",
    "Declared EAP method (not validated)": "Método EAP declarado (no validado)",
    "Ends": "Termina",
    "Event": "Evento",
    "Fragment": "Fragmento",
    "Fragment names": "Nombres del fragmento",
    "Hexadecimal preview": "Vista previa hexadecimal",
    "Declared hidden network (not validated)": "Red oculta declarada (no validada)",
    "Identity": "Identidad",
    "Location": "Ubicación",
    "Message body": "Cuerpo del mensaje",
    "Message recipient": "Destinatario del mensaje",
    "Name": "Nombre",
    "Name components": "Componentes del nombre",
    "Network name (SSID)": "Nombre de red (SSID)",
    "Note": "Nota",
    "OTP setup type": "Tipo de configuración OTP",
    "Organization": "Organización",
    "Original QR content": "Contenido original del código QR",
    "Password": "Contraseña",
    "Path": "Ruta",
    "Declared phase 2 method (not validated)":
      "Método de fase 2 declarado (no validado)",
    "Declared phase 2 method (legacy H, not validated)":
      "Método de fase 2 declarado (H heredado, no validado)",
    "Payment": "Pago",
    "Port": "Puerto",
    "Provisioning type": "Tipo de aprovisionamiento",
    "QR content": "Contenido del código QR",
    "Query names": "Nombres de la consulta",
    "Registrable domain": "Dominio registrable",
    "Declared security type (not validated)":
      "Tipo de seguridad declarado (no validado)",
    "Starts": "Comienza",
    "Structured format": "Formato estructurado",
    "Telephone": "Teléfono",
    "Telephone number": "Número de teléfono",
    "Text": "Texto",
    "Title": "Cargo",
    "URI scheme": "Esquema de URI",
    "Unicode host": "Host Unicode",
  }),
  fieldValues: Object.freeze({
    "None": "Ninguno",
    "Present": "Presente",
    "Present (empty)": "Presente (vacío)",
    "Not present": "No presente",
    "Not available": "No disponible",
    "Unavailable": "No disponible",
    "Empty": "Vacío",
    "Not specified": "No especificado",
    "Yes": "Sí",
    "No": "No",
    "TOTP setup payload": "Carga útil de configuración TOTP",
    "HOTP setup payload": "Carga útil de configuración HOTP",
    "DPP bootstrap data (public key not validated)":
      "Datos de arranque DPP (clave pública no validada)",
    "vCard contact": "Contacto vCard",
    "Calendar entry": "Entrada de calendario",
    "Email details (inspect only)": "Datos de correo (solo inspección)",
    "Message details (inspect only)": "Datos de mensaje (solo inspección)",
    "Payment-related URI (payload not validated)":
      "URI relacionado con pagos (carga útil no validada)",
    "URI scheme recognized; payload not validated":
      "Esquema de URI reconocido; carga útil no validada",
    "URI scheme only (no payload)": "Solo esquema de URI (sin carga útil)",
    "Localhost": "Localhost",
    "Multicast DNS .local": "DNS multicast .local",
    "Home network home.arpa": "Red doméstica home.arpa",
  }),
  portValueEffective: (port: string): string => `${port} (efectivo)`,
  portValueExplicit: (port: string): string => `${port} (explícito)`,
  signalTitles: Object.freeze({
    "ISO-8859-1 assumed (no ECI marker)":
      "Codificación ISO-8859-1 asumida (sin marcador ECI)",
    "Internationalized domain name": "Nombre de dominio internacionalizado",
    "Trailing-dot host": "Host con punto final",
    "Unencrypted HTTP": "HTTP sin cifrar",
    "IP-address destination": "Destino con dirección IP",
    "Local or special-purpose destination": "Destino local o de propósito especial",
    "Non-default port": "Puerto no predeterminado",
    "Link-shortener destination": "Destino en acortador de enlaces",
    "Mixed writing systems": "Sistemas de escritura mezclados",
    "ASCII-like internationalized label": "Etiqueta internacionalizada similar a ASCII",
    "Hidden or control character": "Carácter oculto o de control",
    "Material browser rewrite": "Reescritura material del navegador",
    "Text before @ is not the destination": "El texto antes de @ no es el destino",
    "Forbidden character in the address authority":
      "Carácter prohibido en la autoridad de la dirección",
    "Web address cannot be opened": "La dirección web no puede abrirse",
  }),
  kindLabels: Object.freeze({
    "web-url": "Enlace web",
    wifi: "Datos de Wi-Fi",
    otp: "Datos de configuración OTP",
    dpp: "Datos con formato DPP",
    contact: "Contacto",
    calendar: "Entrada de calendario",
    email: "Datos de correo",
    sms: "Datos de mensaje",
    telephone: "Número de teléfono",
    geo: "Ubicación",
    payment: "URI con esquema de pago",
    "custom-uri": "URI no web",
    gs1: "Datos GS1",
    "iso-15434": "Datos ISO/IEC 15434",
    empty: "Código QR vacío",
    text: "Texto",
    binary: "Bytes sin procesar",
  }),
  signalGlossary: Object.freeze({
    "assumed-iso-8859-1": {
      title: "Codificación ISO-8859-1 asumida (sin marcador ECI)",
      explanation:
        "El símbolo no declaró una codificación ECI y sus bytes no eran UTF-8 válidos, por lo que QRWarden los interpretó como ISO-8859-1. Esto describe cómo se interpretó el texto, no una codificación declarada por el símbolo.",
    },
    "idn-hostname": {
      title: "Nombre de dominio internacionalizado",
      explanation:
        "El destino usa caracteres más allá del ASCII simple. Eso es normal en muchos idiomas, así que QRWarden muestra las formas Unicode y ASCII; comprueba que el nombre que reconoces coincida con ambas.",
    },
    "trailing-dot-host": {
      title: "Host con punto final",
      explanation:
        "El host termina en un punto, la forma explícita de la raíz DNS. Los navegadores lo aceptan, pero los enlaces rara vez lo usan y algunos sitios tratan el nombre con punto como un origen distinto.",
    },
    http: {
      title: "HTTP sin cifrar",
      explanation:
        "La dirección usa http://, así que la conexión no está cifrada. Cualquiera en la ruta de red puede leer o modificar la página que recibirías.",
    },
    "ip-address": {
      title: "Destino con dirección IP",
      explanation:
        "El destino es una dirección de red numérica en lugar de un nombre de dominio. Los servicios públicos casi siempre comparten nombres, así que una dirección en bruto merece una mirada más atenta a dónde apunta realmente.",
    },
    "local-or-special-destination": {
      title: "Destino local o de propósito especial",
      explanation:
        "El host o la dirección pertenece a una categoría local o de propósito especial. Puede ser local, privada, de documentación, multidifusión, reservada o una excepción globalmente alcanzable; revisa la categoría mostrada arriba.",
    },
    "non-default-port": {
      title: "Puerto no predeterminado",
      explanation:
        "La dirección indica un puerto explícito en lugar del puerto web estándar. Puede ser legítimo, pero es inusual en enlaces destinados al público.",
    },
    "link-shortener": {
      title: "Destino en acortador de enlaces",
      explanation:
        "El host es un servicio de acortamiento de enlaces, así que el destino real lo decide quien creó el enlace corto y permanece oculto hasta abrirlo. QRWarden no sigue redirecciones, por lo que no puede mostrarte adónde lleva.",
    },
    "mixed-scripts": {
      title: "Sistemas de escritura mezclados",
      explanation:
        "El host mezcla caracteres de distintos sistemas de escritura en una combinación que el perfil Highly Restrictive de Unicode rechaza. Mezclar escrituras es una forma común de construir nombres imitadores.",
    },
    "confusable-label": {
      title: "Etiqueta internacionalizada similar a ASCII",
      explanation:
        "Parte del host está escrita con caracteres no ASCII que parecen un nombre ASCII corriente. Un nombre que se lee como una marca conocida puede ser un dominio completamente distinto.",
    },
    "hidden-character": {
      title: "Carácter oculto o de control",
      explanation:
        "El código contiene caracteres invisibles o de control fuera de la autoridad de la dirección. Los caracteres ocultos pueden hacer que el texto se lea distinto de cómo se comporta.",
    },
    "material-browser-rewrite": {
      title: "Reescritura material del navegador",
      explanation:
        "Un navegador reescribiría materialmente esta dirección al analizarla, así que lo que lees en el código no es exactamente lo que se abriría. QRWarden muestra el destino analizado que verificó.",
    },
    userinfo: {
      title: "El texto antes de @ no es el destino",
      explanation:
        "Todo lo que va antes del signo @ en una dirección web lo ignora el navegador al elegir el sitio. Los atacantes colocan ahí un nombre familiar para que la dirección se lea como un sitio de confianza.",
    },
    "forbidden-authority-character": {
      title: "Carácter prohibido en la autoridad de la dirección",
      explanation:
        "La parte de la dirección que decide el destino contiene caracteres que nunca son válidos ahí. QRWarden desactiva la apertura porque el destino no puede mostrarse con fidelidad.",
    },
    "malformed-web-url": {
      title: "La dirección web no puede abrirse",
      explanation:
        "El texto parece una dirección web pero no se analiza como una dirección HTTP o HTTPS completa y absoluta con un host, así que no hay un destino verificado que abrir.",
    },
  }),
});
