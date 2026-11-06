// A12 relevance oracle fixed before running embeddings. Synthetic statements only.
// Relevance means material to the question, not truth, support or permission.
export const discoverySources=[
 {key:'launch',text:'El lanzamiento del programa Avena sólo está permitido tras superar todas las pruebas automáticas.',project:'Avena'},
 {key:'withdrawal',text:'El permiso de lanzamiento de Avena queda retirado mientras duren las tareas de mantenimiento.',project:'Avena',retracts:'launch'},
 {key:'travel',text:'El presupuesto destinado a viajes asciende a quinientos euros.'},
 {key:'report',text:'El informe debe entregarse el viernes antes del mediodía.'},
 {key:'payment',text:'La factura se abonará treinta días después de su recepción.'},
 {key:'backup',text:'Se guarda una copia completa del expediente en el disco externo.'},
 {key:'rice',text:'Para cocer el arroz se emplean dos tazas de agua por cada taza de grano.'},
 {key:'planet',text:'Júpiter es el mayor planeta del sistema solar.'}
];
export const discoveryQuestions=[
 {key:'paraphrase-launch',text:'¿Podemos arrancar la aplicación una vez aprobados los controles?',relevant:['launch','withdrawal']},
 {key:'paraphrase-withdrawal',text:'¿Sigue autorizada la puesta en marcha durante las labores de conservación?',relevant:['launch','withdrawal']},
 {key:'paraphrase-travel',text:'¿Cuánto dinero tenemos para desplazamientos?',relevant:['travel']},
 {key:'paraphrase-report',text:'¿En qué momento hay que remitir el documento?',relevant:['report']},
 {key:'paraphrase-payment',text:'¿Qué plazo tenemos para pagar al proveedor?',relevant:['payment']},
 {key:'paraphrase-backup',text:'¿Dónde está el respaldo de todos los datos?',relevant:['backup']},
 {key:'paraphrase-rice',text:'¿Cuánta cantidad de líquido necesita el cereal?',relevant:['rice']},
 {key:'paraphrase-planet',text:'¿Qué mundo de nuestra estrella tiene las mayores dimensiones?',relevant:['planet']},
 {key:'irrelevant-sport',text:'¿Quién ganó el campeonato de baloncesto?',relevant:[]},
 {key:'irrelevant-medicine',text:'¿Cuál es la dosis del antibiótico?',relevant:[]}
];
