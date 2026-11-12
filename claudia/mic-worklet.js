// Raccoglie i campioni del microfono e li passa alla pagina, a blocchi. Nessun salvataggio.
class PostillaMic extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('postilla-mic', PostillaMic);
