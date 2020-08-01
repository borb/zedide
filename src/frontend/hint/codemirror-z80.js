import CodeMirror from 'codemirror'

/**
 * z80 code hinting for codemirror 5.
 * rob andrews <rob@aphlor.org>
 *
 * thanks to the opcode table at https://clrhome.org/table/
 */

((codemirror) => {
  // block level so as not to pollute global space
  const instructions_00 = [
    'nop', 'ld bc,**', 'ld (bc),a', 'inc bc', 'inc b',
    'dec b', 'ld b,*', 'rlca', 'ex af,af\'', 'add hl,bc',
    'ld a,(bc)', 'dec bc', 'inc c', 'dec c', 'ld c,*',
    'rrca', 'djnz *', 'ld de,**', 'ld (de),a', 'inc de',
    'inc d', 'dec d', 'ld d,*', 'rla', 'jr *', 'add hl,de',
    'ld a,(de)', 'dec de', 'inc e', 'dec e', 'ld e,*',
    'rra', 'jr nz,*', 'ld hl,**', 'ld (**),hl', 'inc hl',
    'inc h', 'dec h', 'ld h,*', 'daa', 'jr z,*',
    'add hl,hl', 'ld hl,(**)', 'dec hl', 'inc l', 'dec l',
    'ld l,*', 'cpl', 'jr nc,*', 'ld sp,**', 'ld (**),a',
    'inc sp', 'inc (hl)', 'dec (hl)', 'ld (hl),*', 'scf',
    'jr c,*', 'add hl,sp', 'ld a,(**)', 'dec sp', 'inc a',
    'dec a', 'ld a,*', 'ccf', 'ld b,b', 'ld b,c', 'ld b,d',
    'ld b,e', 'ld b,h', 'ld b,l', 'ld b,(hl)', 'ld b,a',
    'ld c,b', 'ld c,c', 'ld c,d', 'ld c,e', 'ld c,h',
    'ld c,l', 'ld c,(hl)', 'ld c,a', 'ld d,b', 'ld d,c',
    'ld d,d', 'ld d,e', 'ld d,h', 'ld d,l', 'ld d,(hl)',
    'ld d,a', 'ld e,b', 'ld e,c', 'ld e,d', 'ld e,e',
    'ld e,h', 'ld e,l', 'ld e,(hl)', 'ld e,a', 'ld h,b',
    'ld h,c', 'ld h,d', 'ld h,e', 'ld h,h', 'ld h,l',
    'ld h,(hl)', 'ld h,a', 'ld l,b', 'ld l,c', 'ld l,d',
    'ld l,e', 'ld l,h', 'ld l,l', 'ld l,(hl)', 'ld l,a',
    'ld (hl),b', 'ld (hl),c', 'ld (hl),d', 'ld (hl),e',
    'ld (hl),h', 'ld (hl),l', 'halt', 'ld (hl),a',
    'ld a,b', 'ld a,c', 'ld a,d', 'ld a,e', 'ld a,h',
    'ld a,l', 'ld a,(hl)', 'ld a,a', 'add a,b', 'add a,c',
    'add a,d', 'add a,e', 'add a,h', 'add a,l', 'add a,(hl)',
    'add a,a', 'adc a,b', 'adc a,c', 'adc a,d', 'adc a,e',
    'adc a,h', 'adc a,l', 'adc a,(hl)', 'adc a,a', 'sub b',
    'sub c', 'sub d', 'sub e', 'sub h', 'sub l', 'sub (hl)',
    'sub a', 'sbc a,b', 'sbc a,c', 'sbc a,d', 'sbc a,e',
    'sbc a,h', 'sbc a,l', 'sbc a,(hl)', 'sbc a,a', 'and b',
    'and c', 'and d', 'and e', 'and h', 'and l', 'and (hl)',
    'and a', 'xor b', 'xor c', 'xor d', 'xor e', 'xor h',
    'xor l', 'xor (hl)', 'xor a', 'or b', 'or c', 'or d',
    'or e', 'or h', 'or l', 'or (hl)', 'or a', 'cp b',
    'cp c', 'cp d', 'cp e', 'cp h', 'cp l', 'cp (hl)',
    'cp a', 'ret nz', 'pop bc', 'jp nz,**', 'jp **',
    'call nz,**', 'push bc', 'add a,*', 'rst 00h', 'ret z',
    'ret', 'jp z,**', 'call z,**', 'call **', 'adc a,*',
    'rst 08h', 'ret nc', 'pop de', 'jp nc,**', 'out (*),a',
    'call nc,**', 'push de', 'sub *', 'rst 10h', 'ret c',
    'exx', 'jp c,**', 'in a,(*)', 'call c,**', 'sbc a,*',
    'rst 18h', 'ret po', 'pop hl', 'jp po,**', 'ex (sp),hl',
    'call po,**', 'push hl', 'and *', 'rst 20h', 'ret pe',
    'jp (hl)', 'jp pe,**', 'ex de,hl', 'call pe,**',
    'xor *', 'rst 28h', 'ret p', 'pop af', 'jp p,**',
    'di', 'call p,**', 'push af', 'or *', 'rst 30h',
    'ret m', 'ld sp,hl', 'jp m,**', 'ei', 'call m,**',
    'cp *', 'rst 38h'
  ]

  const instructions_ed = [
    // @todo
  ]

  const instructions_cb = [
    // @todo
  ]

  const instructions_dd = [
    // @todo
  ]

  const instructions_ddcb = [
    // @todo
  ]

  const instructions_fd = [
    // @todo
  ]

  const instructions_fdcb = [
    // @todo
  ]

  const z80_instructions = (new Array).concat(
    instructions_00,
    instructions_ed,
    instructions_cb,
    instructions_dd,
    instructions_ddcb,
    instructions_fd,
    instructions_fdcb
  )

  codemirror.registerHelper('hint', 'z80', (editor, options) => {
    let cursor = editor.getCursor(),
        token = editor.getTokenAt(cursor)

    // find any matches which start with token.string
    let matches = z80_instructions.filter((val) => {
      if (val.indexOf(token.string) === 0)
        return val
    })

    return {
      list: matches,
      from: codemirror.Pos(cursor.line, token.start),
      to: codemirror.Pos(cursor.line, token.end)
    }
  })
})(CodeMirror)
