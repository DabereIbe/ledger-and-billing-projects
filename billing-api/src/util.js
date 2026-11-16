// Strict 24-hex check. mongoose.isValidObjectId() also accepts ANY 12-character string,
// which would let junk ids through to the database layer.
export const isId = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
