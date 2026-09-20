(function(){
  "use strict";

  var SUPABASE_URL = "https://ffcrpqtcsgryyqiuoryw.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_PMiP1FvCK4SwQMCXdxpDiQ_9_ggSdHA";
  var supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var sesion = null; // {user, email} cuando hay login activo

  var ENTRAR = -0.55;      // coseno vs. vertical de pie: bajo esto se considera invertido
  var SALIR  = -0.05;      // histéresis de salida (holgado para tolerar sacudidas de cadera al abrir piernas)
  var CONFIRMA_ENTRADA = 700;  // ms sostenidos para confirmar
  var CONFIRMA_SALIDA  = 600;
  var MIN_HOLD = 3000;     // ms mínimos para contar en estadísticas
  var CUENTA_REGRESIVA = 5;    // segundos de margen para acomodar el teléfono antes de calibrar

  var relojEl=document.getElementById("reloj");
  var subEl=document.getElementById("sub");
  var avisoEl=document.getElementById("aviso");
  var btn=document.getElementById("btnPrincipal");
  var btnVoz=document.getElementById("btnVoz");
  var btnManual=document.getElementById("btnManual");
  var btnReset=document.getElementById("btnReset");
  var serieEl=document.getElementById("serie");
  var vacioEl=document.getElementById("vacio");
  var metaValor=document.getElementById("metaValor");
  var btnDiaAnt=document.getElementById("btnDiaAnt");
  var btnDiaSig=document.getElementById("btnDiaSig");
  var fechaMuestra=document.getElementById("fechaMuestra");
  var inputEmail=document.getElementById("inputEmail");
  var btnEnviarLink=document.getElementById("btnEnviarLink");
  var btnCerrarSesion=document.getElementById("btnCerrarSesion");
  var cuentaSinSesion=document.getElementById("cuentaSinSesion");
  var cuentaConSesion=document.getElementById("cuentaConSesion");
  var emailSesion=document.getElementById("emailSesion");
  var estadoSync=document.getElementById("estadoSync");

  var fase="inicio";        // inicio | calibrar | listo | invertido
  var gFiltrada=null;       // vector gravedad suavizado
  var refArriba=null;       // vector de referencia de pie
  var muestrasCal=[], calHasta=0;
  var candidatoEntrada=0, candidatoSalida=0;
  var inicioHold=0, metaAvisada=false;
  var holds=[], meta=30, voz=true, manual=false, sensorVivo=false, ultimoDato=0;
  var wakeLock=null, audioCtx=null, cuentaTimer=null;
  var diaActual=fechaISO(), historial={};

  /* ---------- fecha local (evita el corte de día en UTC) ---------- */
  function fechaISO(d){
    d=d||new Date();
    return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
  }

  /* ---------- almacenamiento histórico por días ---------- */
  function cargarHistorial(){
    try{
      var raw=localStorage.getItem("invertidas:historial");
      if(raw) historial=JSON.parse(raw);
      else historial={};
      // Migración: si existen claves viejas YYYY-MM-DD, traspasar a historial
      for(var i=1;i<=30;i++){
        var fecha=fechaISO(new Date(Date.now()-i*86400000));
        var clave="invertidas:"+fecha;
        var vieja=localStorage.getItem(clave);
        if(vieja){
          try{ historial[fecha]=JSON.parse(vieja); localStorage.removeItem(clave); }catch(e){}
        }
      }
    }catch(e){}
  }
  function guardarHistorial(){
    try{ localStorage.setItem("invertidas:historial",JSON.stringify(historial)); }catch(e){}
  }
  function cargarDia(fecha){
    return historial[fecha]||[];
  }
  function fechaMinima(){
    var claves=Object.keys(historial);
    if(!claves.length) return fechaISO();
    claves.sort();
    return claves[0];
  }
  function guardarDia(fecha,data){
    historial[fecha]=data;
    guardarHistorial();
  }
  function cargar(){
    try{
      cargarHistorial();
      holds=cargarDia(diaActual);
      var m=localStorage.getItem("invertidas:meta");
      if(m!==null) meta=parseInt(m,10)||30;
      var v=localStorage.getItem("invertidas:voz");
      if(v!==null) voz=(v==="1");
    }catch(e){}
  }
  function guardar(){
    try{
      guardarDia(diaActual,holds);
      localStorage.setItem("invertidas:meta",String(meta));
      localStorage.setItem("invertidas:voz",voz?"1":"0");
    }catch(e){}
  }

  /* ---------- sync con Supabase (online-first, cola simple) ---------- */
  function generarId(){
    if(window.crypto&&crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36)+Math.random().toString(36).slice(2);
  }
  function conTimeout(promesa,ms,valorTimeout){
    return new Promise(function(resolve){
      var listo=false;
      var t=setTimeout(function(){
        if(!listo){ listo=true; resolve(valorTimeout); }
      },ms);
      promesa.then(function(v){
        if(!listo){ listo=true; clearTimeout(t); resolve(v); }
      });
    });
  }
  var sincronizando=false;
  function actualizarUiCuenta(){
    if(sesion){
      cuentaSinSesion.classList.add("oculto");
      cuentaConSesion.classList.remove("oculto");
      emailSesion.textContent=sesion.email;
    } else {
      cuentaSinSesion.classList.remove("oculto");
      cuentaConSesion.classList.add("oculto");
    }
    actualizarEstadoSync();
  }
  function actualizarEstadoSync(){
    if(!sesion) return;
    if(!navigator.onLine){ estadoSync.textContent="Sin conexión"; return; }
    var pendientes=0;
    Object.keys(historial).forEach(function(f){
      historial[f].forEach(function(h){ if(!h.sincronizado) pendientes++; });
    });
    estadoSync.textContent = pendientes>0 ? (pendientes+" pendiente"+(pendientes>1?"s":"")) : "Sincronizado";
  }
  function subirYActualizar(hold){
    if(!sesion||!navigator.onLine){ actualizarEstadoSync(); return; }
    intentarSubir(diaActual,hold).then(function(){ guardar(); actualizarEstadoSync(); });
  }
  function intentarSubir(fecha,hold){
    var op=supa.from("holds").insert({
      id:hold.id, user_id:sesion.user.id, fecha:fecha, seg:hold.seg, es_intento:hold.esIntento
    }).then(function(res){
      if(!res.error){ hold.sincronizado=true; return null; }
      return res.error;
    }).catch(function(e){ return e; });
    return conTimeout(op,15000,new Error("tiempo de espera agotado"));
  }
  function traerRemoto(){
    var op=supa.from("holds").select("*").eq("user_id",sesion.user.id).then(function(res){
      if(res.error||!res.data) return;
      var porFecha={};
      res.data.forEach(function(row){
        (porFecha[row.fecha]=porFecha[row.fecha]||[]).push({
          id:row.id, seg:Number(row.seg), esIntento:row.es_intento, sincronizado:true
        });
      });
      Object.keys(porFecha).forEach(function(fecha){
        var locales=historial[fecha]||[];
        var idsLocales={};
        locales.forEach(function(h){ if(h.id) idsLocales[h.id]=true; });
        porFecha[fecha].forEach(function(r){ if(!idsLocales[r.id]) locales.push(r); });
        historial[fecha]=locales;
      });
      guardarHistorial();
    }).catch(function(){});
    return conTimeout(op,15000,null);
  }
  function sincronizarTodo(){
    if(!sesion||!navigator.onLine){ actualizarEstadoSync(); return; }
    if(sincronizando) return;
    sincronizando=true;
    estadoSync.textContent="Sincronizando…";
    var subidas=[];
    Object.keys(historial).forEach(function(fecha){
      historial[fecha].forEach(function(h){
        if(!h.id){ h.id=generarId(); h.sincronizado=false; }
        if(!h.sincronizado) subidas.push(intentarSubir(fecha,h));
      });
    });
    Promise.all(subidas).then(function(errores){
      guardarHistorial();
      var fallos=errores.filter(Boolean);
      return traerRemoto().then(function(){ return fallos; });
    }).then(function(fallos){
      holds=cargarDia(diaActual);
      pintarSerie(); pintarDatos();
      if(fallos.length){
        estadoSync.textContent="Error: "+(fallos[0].message||String(fallos[0]));
      } else {
        actualizarEstadoSync();
      }
    }).catch(function(e){
      estadoSync.textContent="Error: "+(e&&e.message||String(e));
    }).finally(function(){ sincronizando=false; });
  }

  /* ---------- sonido y voz ---------- */
  function ctx(){
    if(!audioCtx){
      var AC=window.AudioContext||window.webkitAudioContext;
      if(!AC) return null;
      try{ audioCtx=new AC(); }catch(e){ return null; }
    }
    if(audioCtx.state==="suspended"){ try{audioCtx.resume();}catch(e){} }
    return audioCtx;
  }
  function tono(freq,dur,vol){
    var c=ctx(); if(!c) return;
    try{
      var o=c.createOscillator(), g=c.createGain();
      o.type="sine"; o.frequency.value=freq;
      g.gain.setValueAtTime(vol||0.22,c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+dur);
      o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime+dur);
    }catch(e){}
  }
  function vibrar(p){ if(navigator.vibrate){ try{navigator.vibrate(p);}catch(e){} } }
  function hablar(texto){
    if(!voz||!window.speechSynthesis) return;
    try{
      var u=new SpeechSynthesisUtterance(texto);
      u.lang="es-CL"; u.rate=1.05;
      window.speechSynthesis.speak(u);
    }catch(e){}
  }

  /* ---------- pantalla encendida ---------- */
  function pedirWakeLock(){
    if(!navigator.wakeLock) return;
    navigator.wakeLock.request("screen").then(function(w){ wakeLock=w; }).catch(function(){});
  }
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState==="visible"&&sensorVivo) pedirWakeLock();
  });

  /* ---------- sensor ---------- */
  function activarSensor(){
    if(!window.DeviceMotionEvent){
      mostrarAviso("Este navegador no entrega datos del acelerómetro. Ábrelo en Chrome o Safari, o usa el modo manual.");
      return;
    }
    if(typeof DeviceMotionEvent.requestPermission==="function"){
      DeviceMotionEvent.requestPermission().then(function(res){
        if(res==="granted") conectar();
        else mostrarAviso("Permiso de movimiento denegado. Vuelve a tocar el botón y acepta, o usa el modo manual.");
      }).catch(function(){
        mostrarAviso("iOS bloqueó el permiso de movimiento aquí. Abre el enlace en una pestaña normal de Safari, o usa el modo manual.");
      });
    } else {
      conectar();
    }
  }
  function conectar(){
    window.addEventListener("devicemotion",onMotion,false);
    ctx(); // desbloquear audio con el gesto del usuario
    pedirWakeLock();
    setTimeout(function(){
      if(!sensorVivo) mostrarAviso("El sensor no está entregando datos. Prueba en el otro teléfono o usa el modo manual.");
    },1500);
    iniciarCuentaRegresiva();
  }
  function onMotion(ev){
    var a=ev.accelerationIncludingGravity;
    if(!a||a.x===null||typeof a.x!=="number") return;
    sensorVivo=true; ultimoDato=performance.now();
    var v={x:a.x,y:a.y,z:a.z};
    if(!gFiltrada) gFiltrada={x:v.x,y:v.y,z:v.z};
    else{
      gFiltrada.x=gFiltrada.x*0.82+v.x*0.18;
      gFiltrada.y=gFiltrada.y*0.82+v.y*0.18;
      gFiltrada.z=gFiltrada.z*0.82+v.z*0.18;
    }
    procesar(ultimoDato);
  }
  function norma(v){ return Math.sqrt(v.x*v.x+v.y*v.y+v.z*v.z); }
  function coseno(){
    if(!gFiltrada||!refArriba) return 1;
    var n1=norma(gFiltrada), n2=norma(refArriba);
    if(n1<0.5||n2<0.5) return 1;
    return (gFiltrada.x*refArriba.x+gFiltrada.y*refArriba.y+gFiltrada.z*refArriba.z)/(n1*n2);
  }

  /* ---------- cuenta regresiva pre-calibración ---------- */
  function cancelarCuentaRegresiva(){
    if(cuentaTimer){ clearInterval(cuentaTimer); cuentaTimer=null; }
  }
  function iniciarCuentaRegresiva(){
    cancelarCuentaRegresiva();
    fase="previo";
    var restante=CUENTA_REGRESIVA;
    subEl.textContent="Acomoda el teléfono y quédate quieto";
    btn.textContent="Preparando…";
    relojEl.textContent=String(restante);
    hablar(String(restante));
    cuentaTimer=setInterval(function(){
      restante--;
      if(restante<=0){
        cancelarCuentaRegresiva();
        empezarCalibracion();
        return;
      }
      relojEl.textContent=String(restante);
      hablar(String(restante));
    },1000);
  }

  /* ---------- calibración ---------- */
  function empezarCalibracion(){
    fase="calibrar"; muestrasCal=[]; calHasta=performance.now()+2000;
    refArriba=null;
    subEl.textContent="Quieto de pie, 2 segundos";
    btn.textContent="Calibrando…";
    tono(520,.12);
  }
  function procesar(ahora){
    if(fase==="calibrar"){
      muestrasCal.push({x:gFiltrada.x,y:gFiltrada.y,z:gFiltrada.z});
      if(ahora>=calHasta&&muestrasCal.length>5){
        var s={x:0,y:0,z:0}, i;
        for(i=Math.floor(muestrasCal.length/2);i<muestrasCal.length;i++){
          s.x+=muestrasCal[i].x; s.y+=muestrasCal[i].y; s.z+=muestrasCal[i].z;
        }
        var n=muestrasCal.length-Math.floor(muestrasCal.length/2);
        refArriba={x:s.x/n,y:s.y/n,z:s.z/n};
        fase="listo";
        subEl.textContent="Súbete cuando quieras";
        btn.textContent="Recalibrar";
        tono(760,.16); vibrar(60);
        hablar("Listo");
      }
      return;
    }
    if(manual) return;
    var c=coseno();
    if(fase==="listo"){
      if(c<ENTRAR){
        if(!candidatoEntrada) candidatoEntrada=ahora;
        else if(ahora-candidatoEntrada>=CONFIRMA_ENTRADA) entrar(candidatoEntrada);
      } else candidatoEntrada=0;
    } else if(fase==="invertido"){
      if(c>SALIR){
        if(!candidatoSalida) candidatoSalida=ahora;
        else if(ahora-candidatoSalida>=CONFIRMA_SALIDA) salir(candidatoSalida);
      } else candidatoSalida=0;
    }
  }

  /* ---------- ciclo del hold ---------- */
  function entrar(t){
    if(diaActual!==fechaISO()){ mostrarAviso("Vuelve a hoy para registrar una invertida."); return; }
    fase="invertido"; candidatoEntrada=0; candidatoSalida=0;
    inicioHold=t; metaAvisada=false;
    document.body.classList.add("invertido");
    subEl.textContent="Corriendo";
    tono(880,.14); vibrar(80);
  }
  function salir(t){
    var dur=t-inicioHold;
    fase="listo"; candidatoSalida=0; candidatoEntrada=0;
    document.body.classList.remove("invertido");
    var seg=Math.round(dur/100)/10;
    var esValido=dur>=MIN_HOLD;
    var hold={id:generarId(),seg:seg,esIntento:!esValido,sincronizado:false};
    holds.push(hold); guardar(); pintarSerie(); pintarDatos();
    subirYActualizar(hold);
    relojEl.textContent=seg.toFixed(1);
    if(esValido){
      var mejores=holds.filter(function(h){return !h.esIntento;}).map(function(h){return h.seg;});
      subEl.textContent=(seg>=Math.max.apply(null,mejores.concat([0]))?"Récord de la sesión":"Registrado");
      tono(520,.1); setTimeout(function(){tono(390,.18);},110);
      vibrar([40,60,40]);
      hablar(seg.toFixed(1).replace(".",",")+" segundos");
    } else {
      subEl.textContent="Registrado como intento (menos de 3s)";
      tono(280,.12);
      vibrar([40,40]);
    }
  }

  /* ---------- pintar ---------- */
  function fmtTotal(s){
    var m=Math.floor(s/60), r=Math.round(s%60);
    if(r===60){m++;r=0;}
    return m+":"+(r<10?"0":"")+r;
  }
  function pintarDatos(){
    var validos=holds.filter(function(h){return !h.esIntento;});
    var n=validos.length;
    var mejor=n?Math.max.apply(null,validos.map(function(h){return h.seg;})):0;
    var suma=validos.reduce(function(a,b){return a+b.seg;},0);
    document.getElementById("dIntentos").textContent=holds.length;
    document.getElementById("dMejor").textContent=mejor.toFixed(1);
    document.getElementById("dProm").textContent=n?(suma/n).toFixed(1):"0.0";
    document.getElementById("dTotal").textContent=fmtTotal(suma);
  }
  function pintarSerie(){
    var validos=holds.filter(function(h){return !h.esIntento;});
    serieEl.innerHTML="";
    if(!validos.length){ vacioEl.classList.remove("oculto"); return; }
    vacioEl.classList.add("oculto");
    var mejor=Math.max.apply(null,validos.map(function(h){return h.seg;}));
    for(var i=validos.length-1;i>=0;i--){
      var li=document.createElement("li");
      var n=document.createElement("span"); n.className="n"; n.textContent="#"+(i+1);
      var t=document.createElement("span");
      t.className="t"+(validos[i].seg===mejor?" record":"");
      t.textContent=validos[i].seg.toFixed(1)+" s";
      li.appendChild(n); li.appendChild(t); serieEl.appendChild(li);
    }
  }
  function mostrarAviso(txt){ avisoEl.textContent=txt; avisoEl.classList.remove("oculto"); }

  /* ---------- navegación de fechas ---------- */
  function actualizarMuestraFecha(){
    var hoy=fechaISO();
    var esHoy=diaActual===hoy;
    var fecha=new Date(diaActual+"T00:00:00Z");
    var meses=["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
    var muestra=fecha.getUTCDate()+" "+meses[fecha.getUTCMonth()]+(esHoy?" (hoy)":" (histórico)");
    fechaMuestra.textContent=muestra;
    if(esHoy) document.body.classList.remove("historico");
    else document.body.classList.add("historico");
    btnDiaSig.disabled=esHoy;
    btnDiaAnt.disabled=(diaActual<=fechaMinima());
    btn.disabled=!esHoy;
    btnReset.disabled=!esHoy;
  }
  function irADia(fecha){
    var hoy=fechaISO();
    if(fecha>hoy) fecha=hoy;
    diaActual=fecha;
    holds=cargarDia(diaActual);
    actualizarMuestraFecha();
    pintarSerie(); pintarDatos();
  }
  function avanzarDia(delta){
    var f=new Date(diaActual+"T00:00:00Z");
    f.setUTCDate(f.getUTCDate()+delta);
    irADia(f.toISOString().slice(0,10));
  }

  /* ---------- bucle de pantalla ---------- */
  function tick(){
    if(fase==="invertido"){
      var seg=(performance.now()-inicioHold)/1000;
      relojEl.textContent=seg.toFixed(1);
      if(!metaAvisada&&meta>0&&seg>=meta){
        metaAvisada=true; tono(1040,.25,.3); vibrar([100,50,100]);
      }
    } else if(fase==="calibrar"){
      relojEl.textContent="0.0";
    }
    if(sensorVivo&&fase!=="inicio"&&performance.now()-ultimoDato>3000){
      sensorVivo=false;
      mostrarAviso("El sensor dejó de responder. Toca la pantalla o recalibra.");
    }
    requestAnimationFrame(tick);
  }

  /* ---------- controles ---------- */
  btn.addEventListener("click",function(){
    ctx();
    if(fase==="inicio") activarSensor();
    else if(manual){ if(fase==="invertido") salir(performance.now()); else entrar(performance.now()); }
    else iniciarCuentaRegresiva();
  });
  btnVoz.addEventListener("click",function(){
    voz=!voz; btnVoz.setAttribute("aria-pressed",voz?"true":"false");
    btnVoz.textContent=voz?"Voz activada":"Voz apagada"; guardar();
    if(voz) hablar("Voz activada");
  });
  btnManual.addEventListener("click",function(){
    manual=!manual; btnManual.setAttribute("aria-pressed",manual?"true":"false");
    btnManual.textContent=manual?"Modo manual activo":"Modo manual";
    if(manual){
      if(fase==="inicio"||fase==="calibrar"||fase==="previo"){ cancelarCuentaRegresiva(); fase="listo"; }
      subEl.textContent="Toca el botón grande para partir y parar";
      btn.textContent="Partir / parar";
    } else {
      btn.textContent=(fase==="inicio")?"Activar sensor":"Recalibrar";
      subEl.textContent="Súbete cuando quieras";
    }
  });
  btnReset.addEventListener("click",function(){
    if(!holds.length) return;
    var txt="¿Borrar ";
    var validos=holds.filter(function(h){return !h.esIntento;}).length;
    var intentos=holds.length-validos;
    if(validos>0) txt+=validos+" hold"+(validos>1?"s":"");
    if(intentos>0) txt+=(validos>0?" y ":"")+ intentos+" intento"+(intentos>1?"s":"");
    txt+=" de hoy?";
    if(confirm(txt)){
      holds=[]; guardar(); pintarSerie(); pintarDatos();
      relojEl.textContent="0.0"; subEl.textContent="Sesión en blanco";
      if(sesion&&navigator.onLine){
        supa.from("holds").delete().eq("user_id",sesion.user.id).eq("fecha",diaActual)
          .then(function(){ actualizarEstadoSync(); }).catch(function(){});
      }
    }
  });
  document.getElementById("metaMenos").addEventListener("click",function(){
    meta=Math.max(0,meta-5); metaValor.textContent=meta?meta+" s":"sin meta"; guardar();
  });
  document.getElementById("metaMas").addEventListener("click",function(){
    meta=Math.min(300,meta+5); metaValor.textContent=meta+" s"; guardar();
  });
  btnDiaAnt.addEventListener("click",function(){ avanzarDia(-1); });
  btnDiaSig.addEventListener("click",function(){ avanzarDia(1); });
  btnEnviarLink.addEventListener("click",function(){
    var email=inputEmail.value.trim();
    if(!email) return;
    btnEnviarLink.disabled=true; btnEnviarLink.textContent="Enviando…";
    supa.auth.signInWithOtp({
      email:email,
      options:{ emailRedirectTo: window.location.origin+window.location.pathname }
    }).then(function(res){
      btnEnviarLink.disabled=false; btnEnviarLink.textContent="Enviar enlace";
      if(res.error) mostrarAviso("No se pudo enviar el enlace: "+res.error.message);
      else mostrarAviso("Revisa tu correo y toca el enlace para entrar.");
    });
  });
  btnCerrarSesion.addEventListener("click",function(){ supa.auth.signOut(); });
  estadoSync.addEventListener("click",function(){ if(sesion) sincronizarTodo(); });
  supa.auth.onAuthStateChange(function(event,session){
    sesion = session ? {user:session.user, email:session.user.email} : null;
    actualizarUiCuenta();
    if(sesion) sincronizarTodo();
  });
  window.addEventListener("online",function(){ if(sesion) sincronizarTodo(); else actualizarEstadoSync(); });
  window.addEventListener("offline",actualizarEstadoSync);

  cargar();
  actualizarMuestraFecha();
  metaValor.textContent=meta?meta+" s":"sin meta";
  btnVoz.textContent=voz?"Voz activada":"Voz apagada";
  btnVoz.setAttribute("aria-pressed",voz?"true":"false");
  pintarSerie(); pintarDatos();
  requestAnimationFrame(tick);
})();
