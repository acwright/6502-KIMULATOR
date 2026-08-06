/**
 * Optional loader: turns a marked-up element into a correctly-sized <iframe>.
 *
 *   <script src="https://acwright.github.io/6502-KIMULATOR/embed.js"></script>
 *   <div data-kim-panels="lcd,keys" data-kim-keys="ESC"></div>
 *
 * Convenience only. A raw <iframe> pointing at embed.html does exactly the same
 * thing and needs no script at all — this exists so a docs page can drop the
 * URL-building and the sizing arithmetic.
 *
 * Every `data-kim-<name>` attribute becomes the `<name>` URL parameter, with no
 * list of known names anywhere in here. That is on purpose: the emulator ignores
 * parameters it does not recognise, so a loader that forwards everything stays
 * useful against a version of the emulator newer than itself.
 *
 * The prefix is `data-kim-` rather than 6502-EMULATOR's `data-6502-`, and the
 * two loaders can therefore sit on one page without either of them claiming the
 * other's containers — which the DOCS site, documenting both machines, is going
 * to need.
 *
 * Deliberately dependency-free ES5-era script rather than a module, so it can be
 * dropped into any page with a plain <script src> and no build step.
 */
;(function () {
  var PREFIX = 'data-kim-'

  /** Attributes that configure the frame itself rather than the machine. */
  var LOCAL = { width: 1, height: 1, class: 1, title: 1, allow: 1 }

  /**
   * Room for all four panels plus the control bar.
   *
   * There is no single raster to double here the way there is on a machine with
   * a video card — the KIM is four panels beside each other — so this is the
   * smallest box in which the terminal is still legible at 40 columns and the
   * pad's caps are still readable. `panels=` subsets want their own sizes; see
   * docs/EMBEDDING.md.
   */
  var DEFAULT_WIDTH = 720
  var DEFAULT_HEIGHT = 480

  // Resolved while the script is still executing, which is the only time
  // document.currentScript is meaningful.
  var script = document.currentScript
  var base = script ? new URL('.', script.src).href : '/'

  /** `bin` and `bin64` repeat; one attribute carries them separated by `;`. */
  function appendValues(query, name, value) {
    if (name === 'bin' || name === 'bin64') {
      var specs = value.split(';')
      for (var i = 0; i < specs.length; i++) {
        var spec = specs[i].trim()
        if (spec) query.append(name, spec)
      }
      return
    }
    query.set(name, value)
  }

  function mount(element) {
    if (element.dataset.embedded === 'true') return
    element.dataset.embedded = 'true'

    var query = new URLSearchParams()
    var width = DEFAULT_WIDTH
    var height = DEFAULT_HEIGHT
    var title = '6502 KIMulator'
    var allow = 'fullscreen'

    var names = element.getAttributeNames()
    for (var i = 0; i < names.length; i++) {
      var attribute = names[i]
      if (attribute.indexOf(PREFIX) !== 0) continue
      var name = attribute.slice(PREFIX.length)
      var value = element.getAttribute(attribute)

      if (LOCAL[name]) {
        if (name === 'width') width = value
        else if (name === 'height') height = value
        else if (name === 'title') title = value
        else if (name === 'allow') allow = value
        continue
      }
      appendValues(query, name, value)
    }

    var frame = document.createElement('iframe')
    frame.src = base + 'embed.html?' + query.toString()
    frame.width = width
    frame.height = height
    frame.title = title
    frame.allow = allow
    frame.style.border = '0'
    frame.style.maxWidth = '100%'
    // The keyboard has to reach the machine, so the frame must be focusable and
    // must not be sandboxed away from the same-origin script that drives it.
    frame.setAttribute('loading', 'lazy')

    var className = element.getAttribute(PREFIX + 'class')
    if (className) frame.className = className

    element.appendChild(frame)
  }

  function mountAll() {
    var elements = document.querySelectorAll(
      '[data-kim],[data-kim-rom],[data-kim-rom64],[data-kim-bin],[data-kim-bin64],' +
        '[data-kim-panels],[data-kim-accessory],[data-kim-keys],[data-kim-autotype],' +
        '[data-kim-controls],[data-kim-autostart],[data-kim-serialcard]'
    )
    for (var i = 0; i < elements.length; i++) mount(elements[i])
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll)
  } else {
    mountAll()
  }

  // Exposed so a page that adds containers after load — a docs site switching
  // tabs, say — can ask for another pass.
  window.mountKIMEmbeds = mountAll
})()
