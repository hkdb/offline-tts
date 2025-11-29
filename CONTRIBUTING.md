# Contributing to OfflineTTS

Thank you for your interest in contributing to OfflineTTS!

## How to Contribute

### Reporting Issues
- Check if the issue already exists
- Provide clear reproduction steps
- Include browser version and OS
- Add relevant console logs if applicable

### Submitting Pull Requests
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly (see Testing section below)
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

### Development Setup
```bash
# Install dependencies
npm install

# Build for development
npm run build

# Load extension in Chrome
# 1. Go to chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked"
# 4. Select the `build/` folder
```

### Code Style
- Follow existing code patterns
- Use 2-space indentation
- Add JSDoc comments for public functions
- Keep console.log for debugging (stripped in production builds)
- Prefix console logs with `[ComponentName]`

### Testing
- Manually test all affected features
- Test in both light and dark mode
- Test keyboard shortcuts
- Test on various websites (Wikipedia, Medium, Reddit, etc.)
- Verify PDF extraction still works

### Commit Messages
- Use clear, descriptive messages
- Start with a verb (Add, Fix, Update, Remove, etc.)
- Reference issue numbers when applicable

Example:
```
Fix duplicate text extraction in nested elements (#42)
```

## Code of Conduct
Be respectful, inclusive, and constructive.

## License
By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
